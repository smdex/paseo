import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  JjUnavailableError,
  NotSupportedOnJjError,
  dispatchGetCheckoutStatus,
  dispatchListPaseoWorktrees,
  dispatchRunStashList,
} from "./checkout-dispatch.js";
import {
  isJjDispatchEnabled,
  isJjFeatureAvailable,
  resetJjRuntimeCache,
  warmJjRuntime,
} from "./vcs-backend.js";
import { createScratchJjRepo, isJjAvailable } from "../test-utils/jj.js";

const jjAvailable = isJjAvailable();
const describeIfJj = describe.skipIf(!jjAvailable);

const disposables: Array<() => void> = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) {
    savedEnv.set(name, process.env[name]);
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  while (disposables.length > 0) {
    const dispose = disposables.pop();
    if (dispose) dispose();
  }
  for (const [name, value] of savedEnv) {
    setEnv(name, value);
    savedEnv.delete(name);
  }
  delete process.env.PASEO_DISABLE_JJ;
  resetJjRuntimeCache();
});

function scratchJj(): string {
  const fixture = createScratchJjRepo({ files: { "readme.md": "hello\n" } });
  disposables.push(fixture.dispose);
  return fixture.repoDir;
}

function scratchGit(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-dispatch-git-"));
  const init = spawnSync("git", ["init", "-q", "."], { cwd: dir });
  if (init.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git init failed: ${init.stderr}`);
  }
  writeFileSync(join(dir, "readme.md"), "hello\n");
  const add = spawnSync("git", ["add", "-A"], { cwd: dir });
  const commit = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
    { cwd: dir },
  );
  if (add.status !== 0 || commit.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("git fixture setup failed");
  }
  disposables.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scratchPlain(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-dispatch-plain-"));
  disposables.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("checkout dispatch gate", () => {
  it("routes a plain directory to the not-git result", async () => {
    const dir = scratchPlain();
    const status = await dispatchGetCheckoutStatus(dir);
    expect(status.isGit).toBe(false);
  });

  it("routes a git repository to the git status (no vcs field)", async () => {
    const dir = scratchGit();
    const status = await dispatchGetCheckoutStatus(dir);
    expect(status.isGit).toBe(true);
    if (status.isGit) {
      expect(status.vcs).toBeUndefined();
      expect(status.currentBranch).toMatch(/^(main|master|trunk|develop)$/);
    }
  });

  describeIfJj("jj routing", () => {
    it("routes a jj repository to the jj status (vcs/changeId set)", async () => {
      const dir = scratchJj();
      const status = await dispatchGetCheckoutStatus(dir);
      expect(status.isGit).toBe(true);
      if (status.isGit) {
        expect(status.vcs).toBe("jj");
        expect(typeof status.changeId).toBe("string");
      }
    });

    it("throws JjUnavailableError when the runtime is disabled, without falling back to git", async () => {
      const dir = scratchJj();
      setEnv("PASEO_DISABLE_JJ", "1");
      resetJjRuntimeCache();
      await expect(dispatchGetCheckoutStatus(dir)).rejects.toBeInstanceOf(JjUnavailableError);
      await expect(dispatchRunStashList(dir)).rejects.toBeInstanceOf(JjUnavailableError);
    });

    it("falls back to the git implementation when dispatch is disabled (escape hatch)", async () => {
      const dir = scratchJj();
      setEnv("PASEO_JJ_DISPATCH", "0");
      // Colocated scratch repo: the git view is coherent (jj colocates by default).
      const status = await dispatchGetCheckoutStatus(dir);
      expect(status.isGit).toBe(true);
      if (status.isGit) {
        expect(status.vcs).toBeUndefined();
      }
    });

    it("rejects stash listing on jj with NotSupportedOnJjError", async () => {
      const dir = scratchJj();
      await expect(dispatchRunStashList(dir)).rejects.toBeInstanceOf(NotSupportedOnJjError);
    });

    it("reports no additional worktrees on jj until Phase D", async () => {
      const dir = scratchJj();
      const worktrees = await dispatchListPaseoWorktrees({ cwd: dir, paseoHome: dir });
      expect(worktrees).toEqual([]);
    });

    it("reflects the warmed probe in isJjFeatureAvailable", async () => {
      warmJjRuntime();
      for (let attempt = 0; attempt < 20 && !isJjFeatureAvailable(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isJjFeatureAvailable()).toBe(true);
    });
  });
});

describe("jj feature advertisement gate", () => {
  it("is disabled while dispatch is off", () => {
    setEnv("PASEO_JJ_DISPATCH", "0");
    expect(isJjFeatureAvailable()).toBe(false);
    expect(isJjDispatchEnabled()).toBe(false);
  });

  it("is disabled while the runtime is disabled", () => {
    setEnv("PASEO_DISABLE_JJ", "1");
    expect(isJjFeatureAvailable()).toBe(false);
  });
});

// CI runners that execute jj-inclusive suites must install jj: a skip here
// would silently drop jj coverage while CI stays green.
describe.skipIf(process.env.CI === undefined || jjAvailable)("jj presence under CI (meta)", () => {
  it("asserts jj is installed in CI so skipped-local never means skipped-CI", () => {
    expect(jjAvailable, "jj must be installed on CI runners that run jj tests").toBe(true);
  });
});
