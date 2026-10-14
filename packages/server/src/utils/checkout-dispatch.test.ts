import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JjUnavailableError,
  NotSupportedOnJjError,
  dispatchCommitChanges,
  dispatchRenameCurrentBranch,
  dispatchDescribeChange,
  dispatchExecuteCreateBranchFromBase,
  dispatchGetCheckoutStatus,
  dispatchListPaseoWorktrees,
  dispatchNewChange,
  dispatchRunStashList,
} from "./checkout-dispatch.js";
import { writePaseoWorktreeMetadata, readPaseoWorktreeMetadata } from "./worktree-metadata.js";
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

/** jj dispatch is opt-in until Phase F; suites that exercise jj routing enable it. */
function enableJjDispatch(): void {
  setEnv("PASEO_JJ_DISPATCH", "1");
  resetJjRuntimeCache();
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
    beforeEach(() => enableJjDispatch());

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

    it("routes detected jj by default when the opt-out is absent", async () => {
      const dir = scratchJj();
      setEnv("PASEO_JJ_DISPATCH", undefined);
      resetJjRuntimeCache();
      const status = await dispatchGetCheckoutStatus(dir);
      expect(status.isGit).toBe(true);
      if (status.isGit) expect(status.vcs).toBe("jj");
      expect(isJjFeatureAvailable()).toBe(true);
    });

    it("refuses detected jj when dispatch is explicitly disabled", async () => {
      const dir = scratchJj();
      setEnv("PASEO_JJ_DISPATCH", "0");
      await expect(dispatchGetCheckoutStatus(dir)).rejects.toMatchObject({
        name: "JjUnavailableError",
        message: expect.stringContaining("PASEO_JJ_DISPATCH=0"),
      });
      await expect(dispatchRunStashList(dir)).rejects.toBeInstanceOf(JjUnavailableError);
      expect(isJjFeatureAvailable()).toBe(false);
    });

    it("refuses detected jj when the binary is missing instead of running enclosing Git", async () => {
      const dir = scratchJj();
      const emptyPath = scratchPlain();
      setEnv("PATH", emptyPath);
      resetJjRuntimeCache();
      await expect(dispatchGetCheckoutStatus(dir)).rejects.toBeInstanceOf(JjUnavailableError);
      await expect(dispatchRunStashList(dir)).rejects.toBeInstanceOf(JjUnavailableError);
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
  it("is enabled by default when no opt-out is configured", () => {
    setEnv("PASEO_JJ_DISPATCH", undefined);
    expect(isJjDispatchEnabled()).toBe(true);
  });

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
  beforeEach(() => enableJjDispatch());
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

describeIfJj("jj branch creation from base", () => {
  beforeEach(() => enableJjDispatch());

  it("creates the feature line ON the validated base, not the current change", async () => {
    const fixture = createScratchJjRepo({ files: { "a.txt": "a\n" } });
    disposables.push(fixture.dispose);
    const baseCommit = fixture
      .jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
      .stdout.trim();
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);

    // Unrelated dirty working change on top of the base.
    writeFileSync(join(fixture.repoDir, "unrelated.txt"), "x\n");

    await dispatchExecuteCreateBranchFromBase(fixture.repoDir, {
      baseBranch: "main",
      newBranchName: "feat/from-base",
    });

    // The new bookmark's line starts at the base commit (its parent chain),
    // and the base bookmark itself never moved.
    const parent = fixture
      .jj(["log", "--no-graph", "-r", "feat/from-base-", "-T", "commit_id"])
      .stdout.trim();
    expect(parent).toBe(baseCommit);
    const mainStill = fixture
      .jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"])
      .stdout.trim();
    expect(mainStill).toBe(baseCommit);
    // The workspace now sits on the new feature line.
    const current = fixture
      .jj(["log", "--no-graph", "-r", "@", "-T", "bookmarks.join(',')"])
      .stdout.trim();
    expect(current).toContain("feat/from-base");
  });

  it("fails typed on an unknown base", async () => {
    const fixture = createScratchJjRepo({ files: { "a.txt": "a\n" } });
    disposables.push(fixture.dispose);
    await expect(
      dispatchExecuteCreateBranchFromBase(fixture.repoDir, {
        baseBranch: "no-such-bookmark",
        newBranchName: "feat/x",
      }),
    ).rejects.toThrow(/base branch not found/i);
  });
});

describeIfJj("jj branch switching", () => {
  beforeEach(() => enableJjDispatch());

  it("defaults to New on the captured bookmark without editing its revision", async () => {
    const fixture = createScratchJjRepo({ files: { "a.txt": "a\n" } });
    disposables.push(fixture.dispose);
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["bookmark", "create", "feature", "-r", "@"]);

    const { dispatchExecuteBranchCheckout } = await import("./checkout-dispatch.js");
    const before = fixture.jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]).stdout.trim();
    const base = fixture.jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"]).stdout.trim();
    await dispatchExecuteBranchCheckout(fixture.repoDir, { kind: "local", name: "main" });
    const after = fixture.jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]).stdout.trim();
    expect(after).not.toBe(before);
    expect(fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim()).toBe(
      base,
    );
    expect(fixture.jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"]).stdout.trim()).toBe(
      base,
    );
  });

  it("keeps the git path unchanged for git repositories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-dispatch-git-"));
    disposables.push(() => rmSync(dir, { recursive: true, force: true }));
    const init = spawnSync("git", ["init", "-q", "."], { cwd: dir });
    if (init.status !== 0) {
      throw new Error(`git init failed: ${init.stderr}`);
    }

    const { dispatchExecuteBranchCheckout } = await import("./checkout-dispatch.js");
    // A git repo resolves through the git implementation, never a jj mutation.
    await expect(
      dispatchExecuteBranchCheckout(dir, { kind: "local", name: "ghost" }),
    ).rejects.not.toBeInstanceOf(NotSupportedOnJjError);
  });
});

describeIfJj("jj dispatch uses daemon placement for ownership", () => {
  beforeEach(() => enableJjDispatch());

  it("never advances the ancestor base for a managed bookmarkless workspace", async () => {
    const fixture = createScratchJjRepo({ files: { "readme.md": "hello\n" } });
    disposables.push(fixture.dispose);
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    const worktreesRoot = join(fixture.dir, "custom-worktrees");
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "bookmarkless",
      worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature" },
    });
    fixture.jj(["bookmark", "delete", "feature"]);
    writePaseoWorktreeMetadata(created.worktreePath, {
      baseRefName: "main",
      baseRef: readPaseoWorktreeMetadata(created.worktreePath)?.baseRef,
      jjBookmark: null,
    });
    const cwd = join(created.worktreePath, "subproject");
    mkdirSync(cwd);
    const context = { worktreesRoot };
    const before = fixture.jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"]).stdout;
    await expect(dispatchGetCheckoutStatus(cwd, context)).resolves.toMatchObject({
      currentBranch: null,
    });
    writeFileSync(join(cwd, "work.txt"), "work\n");
    await dispatchCommitChanges(cwd, { message: "finish work" }, context);
    await dispatchNewChange(cwd, undefined, context);
    expect(fixture.jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"]).stdout).toBe(before);
  });

  it("renames recorded ownership at the workspace root from a subproject", async () => {
    const fixture = createScratchJjRepo({ files: { "readme.md": "hello\n" } });
    disposables.push(fixture.dispose);
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    const worktreesRoot = join(fixture.dir, "custom-worktrees");
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "renamed",
      worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature" },
    });
    const cwd = join(created.worktreePath, "subproject");
    mkdirSync(cwd);
    await dispatchRenameCurrentBranch(cwd, "feature-new", { worktreesRoot });
    expect(readPaseoWorktreeMetadata(created.worktreePath)?.version).toBe(2);
    expect(readPaseoWorktreeMetadata(created.worktreePath)).toMatchObject({
      jjBookmark: "feature-new",
    });
  });
});
