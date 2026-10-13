import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  JjUnavailableError,
  NotSupportedOnJjError,
  dispatchDescribeChange,
  dispatchGetCheckoutStatus,
  dispatchListPaseoWorktrees,
  dispatchNewChange,
  dispatchRunStashList,
} from "./checkout-dispatch.js";
import { createJjWorktree } from "./worktree-jj.js";
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

    it("lists no Paseo workspaces when none were created", async () => {
      const dir = scratchJj();
      const worktrees = await dispatchListPaseoWorktrees({ cwd: dir, paseoHome: dir });
      expect(worktrees).toEqual([]);
    });

    it("lists created jj workspaces through the dispatch", async () => {
      const dir = scratchJj();
      spawnSync(
        "jj",
        [
          "--config",
          "user.name=Paseo Test",
          "--config",
          "user.email=paseo-test@example.invalid",
          "bookmark",
          "create",
          "main",
          "-r",
          "@-",
        ],
        { cwd: dir },
      );
      const worktreesRoot = join(dir, "..", "dispatch-worktrees");
      await createJjWorktree({
        cwd: dir,
        worktreeSlug: "dispatched",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feat/dispatched" },
        worktreesRoot,
      });
      const worktrees = await dispatchListPaseoWorktrees({
        cwd: dir,
        paseoHome: dir,
        worktreesRoot,
      });
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]?.path).toContain("dispatched");
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

describeIfJj("jj change mutations", () => {
  it("describes the working-copy change and reports its ids", async () => {
    const fixture = createScratchJjRepo({ files: { "readme.md": "hello\n" } });
    disposables.push(fixture.dispose);

    const result = await dispatchDescribeChange(fixture.repoDir, { message: "describe me" });

    expect(result.changeId).toMatch(/^[a-z0-9]+$/);
    expect(result.commitId).toMatch(/^[0-9a-f]+$/);
    const description = fixture.jj(["log", "-r", "@", "--no-graph", "-T", "description"]);
    expect(description.status).toBe(0);
    expect(description.stdout.trim()).toBe("describe me");
  });

  it("rejects an empty description", async () => {
    const fixture = createScratchJjRepo({ files: { "readme.md": "hello\n" } });
    disposables.push(fixture.dispose);

    await expect(dispatchDescribeChange(fixture.repoDir, { message: "   " })).rejects.toThrow(
      /description is required/i,
    );
  });

  it("starts a new empty working-copy change on top of the described one", async () => {
    const fixture = createScratchJjRepo({ files: { "readme.md": "hello\n" } });
    disposables.push(fixture.dispose);
    await dispatchDescribeChange(fixture.repoDir, { message: "first change" });

    const result = await dispatchNewChange(fixture.repoDir);

    expect(result.changeId).toMatch(/^[a-z0-9]+$/);
    expect(result.commitId).toMatch(/^[0-9a-f]+$/);
    const parent = fixture.jj(["log", "-r", "@-", "--no-graph", "-T", "description"]);
    expect(parent.status).toBe(0);
    expect(parent.stdout.trim()).toBe("first change");
    const workingCopy = fixture.jj(["log", "-r", "@", "--no-graph", "-T", "description"]);
    expect(workingCopy.status).toBe(0);
    expect(workingCopy.stdout.trim()).toBe("");
  });
});

describe("jj-only change mutations on git repositories", () => {
  it("rejects new change and describe with NotSupportedOnJjError", async () => {
    const dir = scratchGit();
    await expect(dispatchNewChange(dir)).rejects.toBeInstanceOf(NotSupportedOnJjError);
    await expect(dispatchDescribeChange(dir, { message: "x" })).rejects.toBeInstanceOf(
      NotSupportedOnJjError,
    );
  });
});
