import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, afterEach } from "vitest";
import {
  getJjChangeMeta,
  getJjCommitFileDiff,
  getJjDefaultBranch,
  getJjDiff,
  getJjRefDerivedState,
  getJjShortstat,
  getJjSnapshotFacts,
  getJjStatus,
  getJjWorktreeState,
  getJjWorkspaceBookmark,
  hasJjBookmark,
  jjFactsToCheckoutSnapshotFacts,
  listJjBookmarkSuggestions,
  listJjCommits,
  resolveJjBranchCheckout,
  jjPull,
  jjPush,
  jjRenameBookmark,
  jjNew,
  jjDescribe,
  jjCommit,
  jjEdit,
} from "./checkout-jj.js";
import { createScratchJjRepo, isJjAvailable, type ScratchJjRepoFixture } from "../test-utils/jj.js";
import {
  writePaseoWorktreeMetadata,
  writePaseoWorktreeRuntimeMetadata,
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
  readPaseoWorktreeMetadata,
} from "./worktree-metadata.js";

const jjAvailable = isJjAvailable();
const describeIfJj = describe.skipIf(!jjAvailable);

const disposables: Array<() => void> = [];

afterEach(() => {
  while (disposables.length > 0) {
    const dispose = disposables.pop();
    if (dispose) dispose();
  }
});

function scratch(options?: {
  colocate?: boolean;
  files?: Record<string, string>;
}): ScratchJjRepoFixture {
  const fixture = createScratchJjRepo(options);
  disposables.push(fixture.dispose);
  return fixture;
}

function scratchBareGitOrigin(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-jj-origin-"));
  const init = spawnSync("git", ["init", "--bare", "-q", "origin.git"], { cwd: dir });
  if (init.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git init --bare failed: ${init.stderr}`);
  }
  disposables.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "origin.git");
}

function changeIdOf(fixture: ScratchJjRepoFixture, revset: string): string {
  const result = fixture.jj([
    "--no-pager",
    "--color",
    "never",
    "log",
    "--no-graph",
    "-r",
    revset,
    "-T",
    "change_id.short()",
  ]);
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

describeIfJj("checkout-jj snapshot facts", () => {
  it("reports not-jj for a plain directory and for a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-jj-plain-"));
    disposables.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(getJjSnapshotFacts(dir)).resolves.toEqual({ isJj: false });
  });

  it("collects facts from a colocated repo with a bookmark and remote", async () => {
    const fixture = scratch({ colocate: true, files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["new", "-m", "work"]);
    writeFileSync(join(fixture.repoDir, "b.txt"), "b\n");

    const origin = scratchBareGitOrigin();
    fixture.jj(["git", "remote", "add", "origin", origin]);
    fixture.jj(["git", "push", "--bookmark", "main", "--remote", "origin"]);
    fixture.jj(["git", "fetch", "--remote", "origin"]);

    const facts = await getJjSnapshotFacts(fixture.repoDir);
    expect(facts.isJj).toBe(true);
    if (!facts.isJj) return;
    expect(facts.identity.colocated).toBe(true);
    expect(facts.identity.workspaceRoot).toBe(fixture.repoDir);
    expect(facts.derivedBookmark).toBe("main");
    expect(facts.remotes).toEqual([{ name: "origin", url: origin }]);
    expect(facts.resolvedBaseRef).toBe("main");
    expect(facts.storedBaseRef).toBeNull();
    expect(facts.paseoOwnedWorktree).toBe(false);
    // @ holds the new b.txt change → dirty.
    expect(facts.workingCopy.empty).toBe(false);
    expect(facts.workingCopy.changedFiles).toEqual([{ path: "b.txt", status: "added" }]);
    expect(facts.workingCopy.untrackedPaths).toEqual([]);
    expect(facts.workingCopy.meta.bookmarks).toEqual([]);
  });

  it("collects facts from a native (non-colocated) repo", async () => {
    const fixture = scratch({ colocate: false, files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);

    const facts = await getJjSnapshotFacts(fixture.repoDir);
    expect(facts.isJj).toBe(true);
    if (!facts.isJj) return;
    expect(facts.identity.colocated).toBe(false);
    expect(facts.identity.sharedStorePath).toBe(join(fixture.repoDir, ".jj", "repo"));
    expect(facts.derivedBookmark).toBe("main");
  });

  it("derives null when no bookmark exists", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    const facts = await getJjSnapshotFacts(fixture.repoDir);
    expect(facts.isJj).toBe(true);
    if (!facts.isJj) return;
    expect(facts.derivedBookmark).toBeNull();
    expect(facts.resolvedBaseRef).toBeNull();
  });

  it("derives null when two bookmarks sit on the nearest ancestor commit", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["bookmark", "create", "feature", "-r", "@-"]);
    fixture.jj(["new"]);

    const facts = await getJjSnapshotFacts(fixture.repoDir);
    expect(facts.isJj).toBe(true);
    if (!facts.isJj) return;
    expect(facts.derivedBookmark).toBeNull();
  });

  it("derives the unique nearest ancestor bookmark when an older bookmark also exists", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["new", "@-", "-m", "work"]);
    fixture.jj(["bookmark", "create", "feature", "-r", "@"]);
    fixture.jj(["new"]);

    const facts = await getJjSnapshotFacts(fixture.repoDir);
    expect(facts.isJj).toBe(true);
    if (!facts.isJj) return;
    expect(facts.derivedBookmark).toBe("feature");
  });

  it("marks dirty via Untracked paths when jj refuses to snapshot an oversized file", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    writeFileSync(join(fixture.repoDir, "huge.bin"), Buffer.alloc(1_200_000, 7));

    const facts = await getJjSnapshotFacts(fixture.repoDir);
    expect(facts.isJj).toBe(true);
    if (!facts.isJj) return;
    expect(facts.workingCopy.untrackedPaths).toEqual(["huge.bin"]);
    expect(facts.workingCopy.empty).toBe(true);
  });

  it("reads the stored base ref from .paseo worktree metadata in a colocated workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-jj-owned-"));
    disposables.push(() => rmSync(dir, { recursive: true, force: true }));
    const worktreesRoot = join(dir, "worktrees");
    const workspaceDir = join(worktreesRoot, "ab12cd", "my-feature");
    mkdirSync(workspaceDir, { recursive: true });
    const init = spawnSync(
      "jj",
      [
        "--config",
        "user.name=Paseo Test",
        "--config",
        "user.email=paseo-test@example.invalid",
        "git",
        "init",
        "--colocate",
      ],
      {
        cwd: workspaceDir,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, JJ_EDITOR: "true" },
      },
    );
    expect(init.status).toBe(0);
    writeFileSync(join(workspaceDir, "a.txt"), "a\n");
    spawnSync("jj", ["commit", "-m", "initial"], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, JJ_EDITOR: "true" },
    });
    const metadataDir = join(workspaceDir, ".git", "paseo");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(
      join(metadataDir, "worktree.json"),
      JSON.stringify({ version: 2, baseRefName: "main" }),
    );

    const facts = await getJjSnapshotFacts(workspaceDir, { worktreesRoot });
    expect(facts.isJj).toBe(true);
    if (!facts.isJj) return;
    expect(facts.paseoOwnedWorktree).toBe(true);
    expect(facts.storedBaseRef).toBe("main");
    expect(facts.resolvedBaseRef).toBe("main");
  });

  it("resolves facts inside a secondary jj workspace", async () => {
    const fixture = scratch({ colocate: true, files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    const workspaceDir = join(dirname(fixture.repoDir), "secondary");
    const add = fixture.jj(["workspace", "add", workspaceDir, "--name", "secondary"]);
    expect(add.status).toBe(0);

    const facts = await getJjSnapshotFacts(workspaceDir);
    expect(facts.isJj).toBe(true);
    if (!facts.isJj) return;
    // The secondary workspace is its own workspaceRoot but shares the primary
    // store — mainRepoRoot must point at the primary checkout.
    expect(facts.identity.workspaceRoot).toBe(workspaceDir);
    expect(facts.identity.primaryRoot).toBe(fixture.repoDir);
    expect(facts.derivedBookmark).toBe("main");

    const status = await getJjStatus(workspaceDir);
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    expect(status.repoRoot).toBe(workspaceDir);
    expect(status.mainRepoRoot).toBe(fixture.repoDir);
  });

  it("projects facts onto the git-shaped CheckoutSnapshotFacts", async () => {
    const fixture = scratch({ colocate: true, files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);

    const facts = await getJjSnapshotFacts(fixture.repoDir);
    expect(facts.isJj).toBe(true);
    const projected = jjFactsToCheckoutSnapshotFacts(facts);
    expect(projected.isGit).toBe(true);
    if (!projected.isGit) return;
    expect(projected.worktreeRoot).toBe(fixture.repoDir);
    expect(projected.currentBranch).toBe("main");
    expect(projected.mainRepoRoot).toBe(fixture.repoDir);
    expect(projected.gitCommonDir).toBe(join(fixture.repoDir, ".git"));
    expect(projected.paseoWorktree).toEqual({ isPaseoOwnedWorktree: false });
  });
});

describeIfJj("checkout-jj status", () => {
  it("returns isGit false for a plain directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-jj-plain-"));
    disposables.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(getJjStatus(dir)).resolves.toEqual({ isGit: false });
  });

  it("reports non-paseo status with bookmark, base, and dirtiness", async () => {
    const fixture = scratch({ colocate: true, files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["new", "main", "-m", "work"]);
    fixture.jj(["bookmark", "create", "feature", "-r", "@"]);
    writeFileSync(join(fixture.repoDir, "a.txt"), "changed\n");

    const status = await getJjStatus(fixture.repoDir);
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    expect(status.currentBranch).toBe("feature");
    expect(status.isDirty).toBe(true);
    expect(status.baseRef).toBe("main");
    expect(status.hasRemote).toBe(false);
    expect(status.remoteUrl).toBeNull();
    expect(status.isPaseoOwnedWorktree).toBe(false);
    expect(status.mainRepoRoot).toBeNull();
    expect(status.aheadBehind).toEqual({ ahead: 1, behind: 0 });
    // The feature bookmark has no remote counterpart yet — same as git's
    // no-upstream branch.
    expect(status.upstreamRef).toBeNull();
    expect(status.aheadOfOrigin).toBeNull();
  });

  it("reports upstream ahead/behind once the workspace bookmark tracks a remote", async () => {
    const fixture = scratch({ colocate: true, files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["new", "main", "-m", "work"]);
    fixture.jj(["bookmark", "create", "feature", "-r", "@"]);

    const origin = scratchBareGitOrigin();
    fixture.jj(["git", "remote", "add", "origin", origin]);
    fixture.jj(["git", "push", "--bookmark", "feature", "--remote", "origin"]);
    fixture.jj(["git", "fetch", "--remote", "origin"]);

    // A further edit makes @ diverge from the pushed bookmark by one change.
    writeFileSync(join(fixture.repoDir, "a.txt"), "changed\n");

    // The pushed bookmark itself is IN SYNC with its remote: the un-pushed
    // edit rides the working-copy change @, which a bookmark push does not
    // send. Counting @ (the old semantics) would wrongly report "ahead" for
    // a bookmark with nothing new to push. Advancing the bookmark — what a
    // finish-and-push flow does — is what makes it read ahead.
    const synced = await getJjStatus(fixture.repoDir);
    expect(synced.isGit).toBe(true);
    if (synced.isGit) {
      expect(synced.upstreamRef).toBe("origin/feature");
      expect(synced.aheadOfOrigin).toBe(0);
      expect(synced.behindOfOrigin).toBe(0);
    }

    fixture.jj(["describe", "-m", "advance feature"]);
    // Advance the pushed bookmark onto the described change (what the app's
    // finish-and-push flow does via the advance config).
    fixture.jj(["bookmark", "move", "--allow-backwards", "feature", "--to", "@"]);

    const status = await getJjStatus(fixture.repoDir);
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    expect(status.currentBranch).toBe("feature");
    expect(status.hasRemote).toBe(true);
    expect(status.remoteUrl).toBe(origin);
    expect(status.upstreamRef).toBe("origin/feature");
    expect(status.aheadOfOrigin).toBe(1);
    expect(status.behindOfOrigin).toBe(0);
  });

  it("reports the paseo-owned variant when under the worktrees root with a base ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-jj-owned-"));
    disposables.push(() => rmSync(dir, { recursive: true, force: true }));
    const workspaceDir = join(dir, "worktrees", "ab12cd", "my-feature");
    mkdirSync(workspaceDir, { recursive: true });
    const env = { ...process.env, JJ_EDITOR: "true" };
    spawnSync(
      "jj",
      [
        "--config",
        "user.name=T",
        "--config",
        "user.email=t@t.invalid",
        "git",
        "init",
        "--colocate",
      ],
      { cwd: workspaceDir, encoding: "utf8", timeout: 30_000, env },
    );
    writeFileSync(join(workspaceDir, "a.txt"), "a\n");
    spawnSync("jj", ["commit", "-m", "initial"], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: 30_000,
      env,
    });
    const metadataDir = join(workspaceDir, ".git", "paseo");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(
      join(metadataDir, "worktree.json"),
      JSON.stringify({ version: 2, baseRefName: "main" }),
    );

    const status = await getJjStatus(workspaceDir, { worktreesRoot: join(dir, "worktrees") });
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    expect(status.isPaseoOwnedWorktree).toBe(true);
    expect(status.baseRef).toBe("main");
  });
});

describeIfJj("checkout-jj diff", () => {
  it("parses uncommitted modified/deleted/added files", async () => {
    const fixture = scratch({
      files: { "keep.txt": "keep\n", "edit.txt": "line1\nline2\n", "gone.txt": "gone\n" },
    });
    writeFileSync(join(fixture.repoDir, "edit.txt"), "line1\nCHANGED\nline3\n");
    rmSync(join(fixture.repoDir, "gone.txt"));
    writeFileSync(join(fixture.repoDir, "new.txt"), "new\n");

    const result = await getJjDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });
    expect(result.diffTooLarge).not.toBe(true);
    if (result.diffTooLarge) return;
    const byPath = new Map((result.structured ?? []).map((file) => [file.path, file]));
    expect(byPath.get("edit.txt")?.additions).toBe(2);
    expect(byPath.get("edit.txt")?.deletions).toBe(1);
    expect(byPath.get("edit.txt")?.isNew).toBe(false);
    expect(byPath.get("new.txt")?.isNew).toBe(true);
    expect(byPath.get("gone.txt")?.isDeleted).toBe(true);
    expect(result.diff).toContain("diff --git a/edit.txt b/edit.txt");
  });

  it("diffs against a base bookmark in base mode", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["new", "-m", "work"]);
    writeFileSync(join(fixture.repoDir, "a.txt"), "changed\n");
    writeFileSync(join(fixture.repoDir, "b.txt"), "b\n");
    fixture.jj(["new"]);

    const result = await getJjDiff(fixture.repoDir, { mode: "base", includeStructured: true });
    expect(result.diffTooLarge).not.toBe(true);
    if (result.diffTooLarge) return;
    const paths = (result.structured ?? []).map((file) => file.path).sort();
    expect(paths).toEqual(["a.txt", "b.txt"]);
  });

  it("marks a binary file change as a binary placeholder", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    writeFileSync(join(fixture.repoDir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 254, 0, 3]));

    const result = await getJjDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });
    expect(result.diffTooLarge).not.toBe(true);
    if (result.diffTooLarge) return;
    const file = (result.structured ?? []).find((candidate) => candidate.path === "bin.dat");
    expect(file?.status).toBe("binary");
    expect(file?.hunks).toEqual([]);
  });

  it("replaces an oversized single-file patch with a too_large placeholder", async () => {
    // A NEW file over snapshot.max-new-file-size (1MiB) is refused outright,
    // so an oversize PATCH only arises from rewriting a large committed file.
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    const line = "x".repeat(80);
    writeFileSync(join(fixture.repoDir, "big.txt"), `${line}\n`.repeat(12_000));
    fixture.jj(["commit", "-m", "base state"]);
    writeFileSync(join(fixture.repoDir, "big.txt"), `${"y".repeat(80)}\n`.repeat(12_000));

    const result = await getJjDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });
    expect(result.diffTooLarge).not.toBe(true);
    if (result.diffTooLarge) return;
    const file = (result.structured ?? []).find((candidate) => candidate.path === "big.txt");
    expect(file?.status).toBe("too_large");
    expect(file?.hunks).toEqual([]);
  });

  it("returns diffTooLarge when the total patch exceeds the cap", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    const one = `${"x".repeat(80)}\n`.repeat(12_000);
    const two = `${"z".repeat(80)}\n`.repeat(12_000);
    writeFileSync(join(fixture.repoDir, "one.txt"), one);
    writeFileSync(join(fixture.repoDir, "two.txt"), one);
    fixture.jj(["commit", "-m", "base state"]);
    writeFileSync(join(fixture.repoDir, "one.txt"), two);
    writeFileSync(join(fixture.repoDir, "two.txt"), two);

    const result = await getJjDiff(fixture.repoDir, { mode: "uncommitted" });
    expect(result.diffTooLarge).toBe(true);
  });
});

describeIfJj("checkout-jj commits", () => {
  it("lists workspace commits with subjects, files, and counts", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["new", "-m", "first change"]);
    writeFileSync(join(fixture.repoDir, "one.txt"), "one\none\n");
    fixture.jj(["commit", "-m", "first change"]);
    fixture.jj(["new", "-m", "second change"]);
    writeFileSync(join(fixture.repoDir, "two.txt"), "two\n");
    fixture.jj(["commit", "-m", "second change"]);

    const result = await listJjCommits({ cwd: fixture.repoDir });
    expect(result.baseRef).toBe("main");
    const subjects = result.commits.map((commit) => commit.subject);
    expect(subjects).toEqual(["second change", "first change", "initial"]);
    const first = result.commits.find((commit) => commit.subject === "first change");
    expect(first?.files).toEqual([
      { path: "one.txt", additions: 2, deletions: 0, status: "added" },
    ]);
    expect(first?.authorName).toBe("Paseo Test");
    expect(first?.shortSha).toHaveLength(12);
    // Workspace commits have not been pushed to any remote.
    expect(first?.isOnRemote).toBe(false);
    expect(first?.isOnBase).toBe(false);
    const initial = result.commits.find((commit) => commit.subject === "initial");
    expect(initial?.isOnBase).toBe(true);
  });

  it("marks commits on the remote after push and fetch", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["new", "-m", "work"]);
    writeFileSync(join(fixture.repoDir, "b.txt"), "b\n");
    fixture.jj(["commit", "-m", "work"]);

    const before = await listJjCommits({ cwd: fixture.repoDir });
    const workBefore = before.commits.find((commit) => commit.subject === "work");
    expect(workBefore?.isOnRemote).toBe(false);

    const origin = scratchBareGitOrigin();
    fixture.jj(["git", "remote", "add", "origin", origin]);
    fixture.jj(["git", "push", "--bookmark", "main", "--remote", "origin"]);
    fixture.jj(["git", "fetch", "--remote", "origin"]);

    const after = await listJjCommits({ cwd: fixture.repoDir });
    const workAfter = after.commits.find((commit) => commit.subject === "work");
    expect(workAfter?.isOnRemote).toBe(false); // unpushed workspace change
    const initial = after.commits.find((commit) => commit.subject === "initial");
    expect(initial?.isOnRemote).toBe(true); // pushed with main
  });

  it("skips the empty undescribed working-copy change", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["new"]); // empty, undescribed @

    const result = await listJjCommits({ cwd: fixture.repoDir });
    expect(result.commits.map((commit) => commit.subject)).toEqual(["initial"]);
  });
});

describeIfJj("checkout-jj commit file diff", () => {
  function mergeFixture() {
    const fixture = scratch({ files: { "base.txt": "base\n" } });
    fixture.jj(["commit", "-m", "base"]);
    const base = changeIdOf(fixture, "@-");
    fixture.jj(["new"]);
    writeFileSync(join(fixture.repoDir, "one.txt"), "one\n");
    fixture.jj(["describe", "-m", "one"]);
    const one = changeIdOf(fixture, "@");
    fixture.jj(["new", "-r", base]);
    writeFileSync(join(fixture.repoDir, "two.txt"), "two\n");
    fixture.jj(["describe", "-m", "two"]);
    const two = changeIdOf(fixture, "@");
    fixture.jj(["new", one, two, "-m", "merged"]);
    return { fixture, one, two };
  }

  it("uses the first-parent baseline on a merge change", async () => {
    const { fixture, two } = mergeFixture();
    const merged = changeIdOf(fixture, "@");

    // Second-parent file appears via the first-parent comparison; the combined
    // parent diff of a clean merge is empty.
    const diff = await getJjCommitFileDiff({
      cwd: fixture.repoDir,
      change: merged,
      path: "two.txt",
    });
    expect(diff).not.toBeNull();
    expect(diff?.additions).toBe(1);
    expect(diff?.isNew).toBe(true);
    expect(diff?.hunks.length).toBeGreaterThan(0);

    // A first-parent-only file is absent from the merge's own diff.
    const firstParentFile = await getJjCommitFileDiff({
      cwd: fixture.repoDir,
      change: merged,
      path: "one.txt",
    });
    expect(firstParentFile).toBeNull();
    expect(two).toBeTruthy();
  });

  it("returns a parsed file diff for a regular change", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["new", "-m", "work"]);
    writeFileSync(join(fixture.repoDir, "a.txt"), "a\nmore\n");
    fixture.jj(["commit", "-m", "work"]);
    const work = changeIdOf(fixture, "@-");

    const diff = await getJjCommitFileDiff({ cwd: fixture.repoDir, change: work, path: "a.txt" });
    expect(diff).not.toBeNull();
    expect(diff?.additions).toBe(1);
    expect(diff?.hunks[0]?.lines.some((line) => line.content === "more")).toBe(true);
  });

  it("returns null for a path the change does not touch", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["new", "-m", "work"]);
    writeFileSync(join(fixture.repoDir, "b.txt"), "b\n");
    fixture.jj(["commit", "-m", "work"]);
    const work = changeIdOf(fixture, "@-");

    const diff = await getJjCommitFileDiff({ cwd: fixture.repoDir, change: work, path: "a.txt" });
    expect(diff).toBeNull();
  });
});

describeIfJj("checkout-jj change meta", () => {
  it("round-trips metadata including bookmarks", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    fixture.jj(["new", "main", "-m", "described change"]);

    const meta = await getJjChangeMeta(fixture.repoDir, "@");
    expect(meta).not.toBeNull();
    if (!meta) return;
    expect(meta.description).toBe("described change\n");
    expect(meta.changeId).toHaveLength(32);
    expect(meta.commitId).toHaveLength(40);
    expect(meta.parents).toHaveLength(1);
    expect(meta.author.name).toBe("Paseo Test");
    expect(meta.bookmarks).toEqual([]);

    const baseMeta = await getJjChangeMeta(fixture.repoDir, "@-");
    expect(baseMeta?.bookmarks).toEqual(["main"]);
  });
});

describeIfJj("checkout-jj dispatch helpers", () => {
  it("getJjShortstat sums working-copy additions/deletions", async () => {
    const fixture = scratch({ files: { "a.txt": "1\n2\n3\n" } });
    fixture.jj(["new", "-m", "wip"]);
    writeFileSync(join(fixture.repoDir, "a.txt"), "1\nCHANGED\n3\n4\n");
    writeFileSync(join(fixture.repoDir, "b.txt"), "new\n");

    const shortstat = await getJjShortstat(fixture.repoDir);
    expect(shortstat).toEqual({ additions: 3, deletions: 1 });
  });

  it("getJjShortstat returns null on an empty working copy", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["new", "-m", "fresh"]);
    const shortstat = await getJjShortstat(fixture.repoDir);
    expect(shortstat).toBeNull();
  });

  it("getJjWorktreeState reports dirty only with real changes", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["new", "-m", "clean"]);
    const clean = await getJjWorktreeState(fixture.repoDir);
    expect(clean.isDirty).toBe(false);

    writeFileSync(join(fixture.repoDir, "a.txt"), "changed\n");
    const dirty = await getJjWorktreeState(fixture.repoDir);
    expect(dirty.isDirty).toBe(true);
    expect(dirty.diffStat).toEqual({ additions: 1, deletions: 1 });
  });

  it("getJjRefDerivedState derives ahead/behind vs base and upstream presence", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@"]);
    fixture.jj(["new", "main", "-m", "first feature"]);
    writeFileSync(join(fixture.repoDir, "a.txt"), "a\nmore\n");
    fixture.jj(["new", "-m", "second feature"]);

    // Working directly on the base bookmark: same-name guard, mirroring git's
    // getAheadBehind (base === branch → null).
    const onBase = await getJjRefDerivedState(fixture.repoDir);
    expect(onBase.aheadBehind).toBeNull();

    // A distinct workspace bookmark derives counts above the base.
    fixture.jj(["bookmark", "create", "feature-z", "-r", "@"]);
    fixture.jj(["new", "-m", "third feature"]);
    const onFeature = await getJjRefDerivedState(fixture.repoDir);
    expect(onFeature.aheadBehind).toEqual({ ahead: 3, behind: 0 });
    // No remote exists, so upstreamStatus stays null.
    expect(onFeature.upstreamStatus).toBeNull();
    expect(onFeature.diffStat).toBeNull();
  });

  it("getJjDefaultBranch resolves main/master bookmarks", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    expect(await getJjDefaultBranch(fixture.repoDir)).toBeNull();
    fixture.jj(["bookmark", "create", "main", "-r", "@"]);
    expect(await getJjDefaultBranch(fixture.repoDir)).toBe("main");
  });

  it("hasJjBookmark and resolveJjBranchCheckout answer bookmark lookups", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "feature-x", "-r", "@"]);

    expect(await hasJjBookmark(fixture.repoDir, "feature-x")).toBe(true);
    expect(await hasJjBookmark(fixture.repoDir, "missing")).toBe(false);
    await expect(resolveJjBranchCheckout(fixture.repoDir, "feature-x")).resolves.toEqual({
      kind: "local",
      name: "feature-x",
    });
    await expect(resolveJjBranchCheckout(fixture.repoDir, "missing")).resolves.toEqual({
      kind: "not-found",
    });
  });

  it("listJjBookmarkSuggestions lists bookmarks with local presence", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@"]);
    fixture.jj(["new", "main", "-m", "work"]);
    fixture.jj(["bookmark", "create", "feature-y", "-r", "@"]);

    const suggestions = await listJjBookmarkSuggestions(fixture.repoDir);
    const names = suggestions.map((s) => s.name);
    expect(names).toContain("main");
    expect(names).toContain("feature-y");
    for (const suggestion of suggestions) {
      expect(suggestion.hasLocal).toBe(true);
      expect(suggestion.hasRemote).toBe(false);
      expect(Number.isFinite(suggestion.committerDate)).toBe(true);
    }

    const filtered = await listJjBookmarkSuggestions(fixture.repoDir, { query: "feature" });
    expect(filtered.map((s) => s.name)).toEqual(["feature-y"]);

    const limited = await listJjBookmarkSuggestions(fixture.repoDir, { limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

describeIfJj("checkout-jj remote ops", () => {
  it("jjPush fails typed without a workspace bookmark", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    await expect(jjPush(fixture.repoDir)).rejects.toThrow(/no bookmark tracks this line/i);
  });

  it("jjPush fails typed without any remote", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "feature", "-r", "@"]);
    await expect(jjPush(fixture.repoDir)).rejects.toThrow(/no git remote is configured/i);
  });

  it("jjPush pushes the workspace bookmark to the single remote", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    const origin = scratchBareGitOrigin();
    fixture.jj(["git", "remote", "add", "origin", origin]);
    fixture.jj(["new", "@-", "-m", "described work"]);

    await jjPush(fixture.repoDir).catch((error: unknown) => {
      // No bookmark yet → typed failure is the expected first outcome.
      expect(String(error)).toMatch(/no bookmark tracks this line/i);
    });

    fixture.jj(["bookmark", "create", "feature", "-r", "@"]);
    await jjPush(fixture.repoDir);

    const remoteRefs = spawnSync("git", ["ls-remote", origin], { encoding: "utf8" });
    expect(remoteRefs.status).toBe(0);
    expect(remoteRefs.stdout).toContain("refs/heads/feature");
  });

  it("jjPull fetches tracked bookmarks from the remote", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    const origin = scratchBareGitOrigin();
    fixture.jj(["git", "remote", "add", "origin", origin]);
    fixture.jj(["new", "@-", "-m", "work"]);
    fixture.jj(["bookmark", "create", "feature", "-r", "@"]);
    fixture.jj(["git", "push", "--bookmark", "feature", "--remote", "origin"]);

    // Move the workspace forward locally, then pull: the tracked remote
    // bookmark is imported and visible as origin/feature.
    fixture.jj(["new", "-m", "local follow-up"]);
    await jjPull(fixture.repoDir);
    // Tracking is implicit on push (verified: "already tracked"); the default
    // list template hides the @origin suffix while local == remote, so assert
    // the remote revset resolves to the same commit as the local bookmark.
    const remoteCommit = fixture.jj([
      "--no-pager",
      "--color",
      "never",
      "log",
      "--no-graph",
      "-r",
      "feature@origin",
      "-T",
      "commit_id",
    ]);
    const localCommit = fixture.jj([
      "--no-pager",
      "--color",
      "never",
      "log",
      "--no-graph",
      "-r",
      "feature",
      "-T",
      "commit_id",
    ]);
    expect(remoteCommit.status).toBe(0);
    expect(remoteCommit.stdout.trim()).toBe(localCommit.stdout.trim());
  });

  it("jjRenameBookmark renames the workspace bookmark and reports both names", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["new", "@-", "-m", "work"]);
    fixture.jj(["bookmark", "create", "feature", "-r", "@"]);

    const result = await jjRenameBookmark(fixture.repoDir, "renamed-feature");
    expect(result).toEqual({ previousBranch: "feature", currentBranch: "renamed-feature" });
    expect(fixture.jj(["bookmark", "list"]).stdout).toContain("renamed-feature");

    // With the workspace bookmark gone there is nothing to rename — typed.
    fixture.jj(["bookmark", "delete", "renamed-feature"]);
    await expect(jjRenameBookmark(fixture.repoDir, "anything")).rejects.toThrow(
      /nothing to rename/i,
    );
  });
});

describeIfJj("checkout-jj stale reads", () => {
  it("recovers snapshot facts from a stale working copy (review fix 15)", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["new", "@-", "-m", "base work"]);

    // Rewrite the checked-out commit from a second workspace → stale.
    const second = join(fixture.dir, "second");
    fixture.jj(["workspace", "add", second, "--name", "second", "--revision", "main"]);
    fixture.jj(["rebase", "-s", "@", "-d", "root()"], second);

    // A plain command would fail with "The working copy is stale"; facts reads
    // recover via update-stale + retry.
    const facts = await getJjSnapshotFacts(fixture.repoDir);
    expect(facts.isJj).toBe(true);
  });
});

describeIfJj("checkout-jj history first-parent files", () => {
  it("lists merge-introduced files from the first-parent baseline (review fix 13)", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);

    // Main line: one described change on the base.
    fixture.jj(["new", "@-", "-m", "main line"]);
    writeFileSync(join(fixture.repoDir, "a.txt"), "a\nmain\n");
    fixture.jj(["commit", "-m", "main line"]);
    const mainLine = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim();

    // Side change with its own file.
    fixture.jj(["new", mainLine, "-m", "side work"]);
    writeFileSync(join(fixture.repoDir, "side.txt"), "side\n");
    fixture.jj(["commit", "-m", "side work"]);
    const side = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim();

    // A real merge: two parents.
    fixture.jj(["new", mainLine, side, "-m", "merged main line"]);

    const { commits } = await listJjCommits({ cwd: fixture.repoDir });
    const mergeCommit = commits.find((commit) => commit.subject === "merged main line");
    expect(mergeCommit).toBeTruthy();
    // The second-parent file appears in the merge's file list (the combined
    // diff would show none).
    expect(mergeCommit?.files.map((file) => file.path)).toContain("side.txt");
  });
});

describeIfJj("checkout-jj root-relative filesets (subdirectory callers)", () => {
  it("discards the requested root-relative paths from a subdirectory cwd", async () => {
    const fixture = scratch({
      files: { "a.txt": "original\n", "sub/c.txt": "original\n" },
    });
    writeFileSync(join(fixture.repoDir, "a.txt"), "changed\n");
    writeFileSync(join(fixture.repoDir, "sub", "c.txt"), "changed\n");

    const { jjDiscard } = await import("./checkout-jj.js");
    await jjDiscard(join(fixture.repoDir, "sub"), ["a.txt"]);

    expect(readFileSync(join(fixture.repoDir, "a.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(join(fixture.repoDir, "sub", "c.txt"), "utf8")).toBe("changed\n");
  });

  it("returns the requested file's diff from a subdirectory cwd", async () => {
    const fixture = scratch({
      files: { "a.txt": "one\ntwo\n", "sub/c.txt": "one\ntwo\n" },
    });
    fixture.jj(["describe", "-m", "touch both"]);
    writeFileSync(join(fixture.repoDir, "a.txt"), "one\nTWO\n");
    writeFileSync(join(fixture.repoDir, "sub", "c.txt"), "one\nTWO\n");
    fixture.jj(["commit", "-m", "touch both"]);
    const change = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim();

    const diff = await getJjCommitFileDiff({
      cwd: join(fixture.repoDir, "sub"),
      change,
      path: "a.txt",
    });
    expect(diff).not.toBeNull();
    expect(diff?.path).toBe("a.txt");
    expect(diff?.additions).toBe(1);
    expect(diff?.deletions).toBe(1);
  });
});

describeIfJj("checkout-jj managed bookmark ownership", () => {
  interface ManagedFixture {
    repoDir: string;
    workspacePath: string;
    worktreesRoot: string;
    jj: ScratchJjRepoFixture["jj"];
  }

  function managedFixture(options?: { jjBookmark?: string | null }): ManagedFixture {
    const fixture = scratch({ colocate: true, files: { "readme.md": "hello\n" } });
    const base = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim();
    fixture.jj(["bookmark", "create", "main", "-r", base]);
    const worktreesRoot = join(fixture.dir, "worktrees-home");
    mkdirSync(worktreesRoot, { recursive: true });
    const workspacePath = join(worktreesRoot, "projhash", "owned-ws");
    mkdirSync(dirname(workspacePath), { recursive: true });
    fixture.jj(["workspace", "add", workspacePath, "--name", "owned-ws"]);
    writePaseoWorktreeMetadata(workspacePath, {
      baseRefName: "main",
      baseRef: base,
      ...(options?.jjBookmark !== undefined && options.jjBookmark !== null
        ? { jjBookmark: options.jjBookmark }
        : {}),
    });
    if (options?.jjBookmark) {
      fixture.jj(["bookmark", "create", options.jjBookmark, "-r", "owned-ws@"], workspacePath);
    }
    return { repoDir: fixture.repoDir, workspacePath, worktreesRoot, jj: fixture.jj };
  }

  it("status uses the recorded owner, not the derived ancestor bookmark", async () => {
    const managed = managedFixture({ jjBookmark: "feat/owned" });
    const status = await getJjStatus(managed.workspacePath, {
      worktreesRoot: managed.worktreesRoot,
    });
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    expect(status.currentBranch).toBe("feat/owned");
  });

  it("managed ownership null never falls back to ancestor inference", async () => {
    const managed = managedFixture({ jjBookmark: null });
    const status = await getJjStatus(managed.workspacePath, {
      worktreesRoot: managed.worktreesRoot,
    });
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    // The workspace's parent chain carries `main`, but Paseo manages this
    // workspace and recorded NO owner — deriving `main` would advance the
    // base on the next commit.
    expect(status.currentBranch).toBeNull();
  });

  it("persists explicit null ownership and rejects materialized comparison mismatch", async () => {
    const managed = managedFixture({ jjBookmark: null });
    const metadata = readPaseoWorktreeMetadata(managed.workspacePath)!;
    writePaseoWorktreeMetadata(managed.workspacePath, {
      baseRefName: metadata.baseRefName,
      baseRef: metadata.baseRef,
      jjBookmark: null,
    });
    const context = {
      worktreesRoot: managed.worktreesRoot,
      paseoHome: join(managed.worktreesRoot, "home"),
    };
    await jjDescribe(managed.workspacePath, { message: "explicit no owner" }, context);
    const { readJjCheckpoint } = await import("./jj-checkpoint.js");
    expect(
      (await readJjCheckpoint(managed.workspacePath, context.paseoHome))!.metadata,
    ).toMatchObject({ version: 2, jjBookmark: null });
    expect(await getJjWorkspaceBookmark(managed.workspacePath, context)).toBeNull();
    writePaseoWorktreeMetadata(managed.workspacePath, {
      baseRefName: "other-base",
      baseRef: metadata.baseRef,
      jjBookmark: null,
    });
    await expect(
      jjDescribe(managed.workspacePath, { message: "must not adopt altered base" }, context),
    ).rejects.toThrow("metadata does not match");
    expect((await getJjChangeMeta(managed.workspacePath, "@"))!.description.trim()).toBe(
      "explicit no owner",
    );
  });

  it("commit from a subdirectory advances the recorded owner, never the base", async () => {
    const managed = managedFixture({ jjBookmark: "feat/owned" });
    const subprojectDir = join(managed.workspacePath, "subdir");
    mkdirSync(subprojectDir, { recursive: true });
    writeFileSync(join(managed.workspacePath, "work.txt"), "work\n");
    const mainBefore = managed
      .jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"])
      .stdout.trim();
    const result = await jjCommit(subprojectDir, {
      message: "advance the owner",
    });
    expect(result.bookmark).toBe("feat/owned");
    const mainTarget = managed
      .jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"])
      .stdout.trim();
    expect(mainTarget).toBe(mainBefore); // base never advanced
    const ownerOnHead = managed
      .jj(["log", "--no-graph", "-r", "feat/owned", "-T", "commit_id"])
      .stdout.trim();
    expect(ownerOnHead).not.toBe(mainBefore); // owner advanced onto the work
  });
});

describeIfJj("checkout-jj diff and history hardening", () => {
  it("marks a truncated history patch as too_large instead of parsing it", async () => {
    const bigLine = "x".repeat(64);
    const fixture = scratch({ files: { "huge.txt": `${bigLine}\n` } });
    const replaced = `${bigLine} replaced\n`.repeat(24_000); // > 1MB patch
    writeFileSync(join(fixture.repoDir, "huge.txt"), replaced);
    fixture.jj(["commit", "-m", "huge change"]);
    const change = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim();

    const diff = await getJjCommitFileDiff({ cwd: fixture.repoDir, change, path: "huge.txt" });
    expect(diff).not.toBeNull();
    expect(diff?.status).toBe("too_large");
    expect(diff?.hunks).toEqual([]);
  }, 60_000);

  it("keeps the binary marker on mixed binary/text diffs", async () => {
    const fixture = scratch({ files: { "text.txt": "one\n" } });
    writeFileSync(join(fixture.repoDir, "text.txt"), "two\n");
    writeFileSync(join(fixture.repoDir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3, 0]));

    const result = await getJjDiff(fixture.repoDir, {
      mode: "uncommitted",
      includeStructured: true,
    });
    expect(result.diffTooLarge).toBeFalsy();
    const structured = result.structured ?? [];
    const binary = structured.find((file) => file.path === "blob.bin");
    const text = structured.find((file) => file.path === "text.txt");
    expect(binary?.status).toBe("binary");
    expect(text?.status).toBeUndefined();
  });

  it("compares only the selected push remote and excludes the empty working-copy child", async () => {
    const fixture = scratch({ files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    const origin = scratchBareGitOrigin();
    const backup = scratchBareGitOrigin();
    fixture.jj(["git", "remote", "add", "origin", origin]);
    fixture.jj(["git", "remote", "add", "backup", backup]);
    fixture.jj(["git", "push", "--bookmark", "main", "--remote", "origin"]);
    writeFileSync(join(fixture.repoDir, "new.txt"), "one ahead\n");
    fixture.jj([
      "commit",
      "-m",
      "one ahead",
      "--config",
      'experimental-advance-branches.enabled-branches=["main"]',
    ]);
    fixture.jj(["git", "push", "--bookmark", "main", "--remote", "backup"]);
    fixture.jj(["git", "fetch", "--remote", "origin"]);
    fixture.jj(["git", "fetch", "--remote", "backup"]);
    await expect(getJjStatus(fixture.repoDir)).resolves.toMatchObject({
      aheadOfOrigin: 1,
      behindOfOrigin: 0,
    });
    fixture.jj(["git", "push", "--bookmark", "main", "--remote", "origin"]);
    await expect(getJjStatus(fixture.repoDir)).resolves.toMatchObject({
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
    });
  });

  it("counts upstream ahead against the bookmark target, not the empty working copy", async () => {
    const fixture = scratch({ colocate: true, files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    const origin = scratchBareGitOrigin();
    fixture.jj(["git", "remote", "add", "origin", origin]);
    fixture.jj(["git", "push", "--bookmark", "main", "--remote", "origin"]);
    fixture.jj(["git", "fetch", "--remote", "origin"]);

    // Finish the described change onto main (the bookmark advances past the
    // pushed remote state by exactly one described change).
    writeFileSync(join(fixture.repoDir, "b.txt"), "b\n");
    fixture.jj(["describe", "-m", "one ahead"]);
    fixture.jj(["bookmark", "move", "--allow-backwards", "main", "--to", "@"]);

    const status = await getJjStatus(fixture.repoDir);
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    expect(status.aheadOfOrigin).toBe(1);
    expect(status.behindOfOrigin).toBe(0);
  });
});

describeIfJj("checkout-jj rename preserves metadata", () => {
  it("updates only jjBookmark and keeps runtime metadata", async () => {
    const fixture = scratch({ colocate: true, files: { "readme.md": "hello\n" } });
    const base = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim();
    fixture.jj(["bookmark", "create", "main", "-r", base]);
    const worktreesRoot = join(fixture.dir, "worktrees-home");
    mkdirSync(worktreesRoot, { recursive: true });
    const workspacePath = join(worktreesRoot, "projhash", "renamable");
    mkdirSync(dirname(workspacePath), { recursive: true });
    fixture.jj(["workspace", "add", workspacePath, "--name", "renamable"]);
    fixture.jj(["bookmark", "create", "feat/old", "-r", "renamable@"], workspacePath);
    writePaseoWorktreeMetadata(workspacePath, {
      baseRefName: "main",
      baseRef: base,
      jjBookmark: "feat/old",
    });
    writePaseoWorktreeRuntimeMetadata(workspacePath, { worktreePort: 4242 });
    writePaseoWorktreeFirstAgentBranchAutoNameMetadata(workspacePath, {
      placeholderBranchName: "feat/old",
    });
    const metadataBefore = readPaseoWorktreeMetadata(workspacePath);

    await jjRenameBookmark(workspacePath, "feat/new", { worktreesRoot });

    const updated = readPaseoWorktreeMetadata(workspacePath);
    expect(updated).toEqual({ ...metadataBefore, jjBookmark: "feat/new" });
    expect(updated?.version).toBe(2);
    expect(updated?.jjBookmark).toBe("feat/new");
    expect(updated?.runtime?.worktreePort).toBe(4242);
  });
});

describeIfJj("jj local core parity", () => {
  it("lists bounded bookmarkless ancestry and preserves a dirty current change on Fetch", async () => {
    const fixture = scratch({ colocate: false, files: { "a.txt": "base\n" } });
    const remote = scratchBareGitOrigin();
    fixture.jj(["git", "remote", "add", "upstream", remote]);
    writeFileSync(join(fixture.repoDir, "a.txt"), "dirty\n");
    fixture.jj(["describe", "-m", "dirty current"]);
    const before = changeIdOf(fixture, "@");
    await jjPull(fixture.repoDir);
    expect(readFileSync(join(fixture.repoDir, "a.txt"), "utf8")).toBe("dirty\n");
    expect(changeIdOf(fixture, "@")).toBe(before);
    const history = await listJjCommits({ cwd: fixture.repoDir });
    expect(history.baseRef).toBeNull();
    expect(history.commits.map((commit) => commit.subject)).toEqual(["dirty current", "initial"]);
    expect(history.commits.every((commit) => !commit.isOnBase)).toBe(true);
    await expect(getJjStatus(fixture.repoDir)).resolves.toMatchObject({
      defaultWorkspaceBase: { refName: "@", displayName: "Current change" },
      hasRemote: true,
    });
  });

  it("lists exact selected non-origin remote-only/local targets in seconds and hides private pins", async () => {
    const source = scratch({ files: { "a.txt": "base\n" } });
    const remote = scratchBareGitOrigin();
    source.jj(["bookmark", "create", "remote-only", "-r", "@-"]);
    source.jj(["git", "remote", "add", "upstream", remote]);
    source.jj(["git", "push", "--remote", "upstream", "--bookmark", "remote-only"]);
    const target = scratch({ colocate: false, files: { "b.txt": "local\n" } });
    target.jj(["git", "remote", "add", "upstream", remote]);
    target.jj(["git", "fetch", "--remote", "upstream"]);
    target.jj(["bookmark", "create", "local", "-r", "@-"]);
    target.jj(["bookmark", "create", "paseo/recovery/private", "-r", "@-"]);
    const suggestions = await listJjBookmarkSuggestions(target.repoDir);
    const localId = target
      .jj(["log", "--no-graph", "-r", "local", "-T", "commit_id"])
      .stdout.trim();
    const remoteId = source
      .jj(["log", "--no-graph", "-r", "remote-only", "-T", "commit_id"])
      .stdout.trim();
    expect(suggestions.map((row) => row.name).sort()).toEqual(["local", "remote-only"]);
    expect(suggestions.find((row) => row.name === "local")).toMatchObject({
      localRef: localId,
      hasLocal: true,
      hasRemote: false,
    });
    expect(suggestions.find((row) => row.name === "remote-only")).toMatchObject({
      remoteRef: remoteId,
      remoteName: "upstream",
      hasLocal: false,
      hasRemote: true,
    });
    expect(suggestions.every((row) => row.committerDate < 100_000_000_000)).toBe(true);
    const { createJjWorktree } = await import("./worktree-jj.js");
    const created = await createJjWorktree({
      cwd: target.repoDir,
      worktreeSlug: "from-picker",
      source: { kind: "branch-off", baseBranch: remoteId, branchName: "from-picker" },
      worktreesRoot: join(target.dir, "worktrees"),
      runSetup: false,
    });
    expect(readPaseoWorktreeMetadata(created.worktreePath)?.baseRef).toBe(remoteId);
  });

  it("keeps dirty unreachable work when fetch prunes a remote bookmark", async () => {
    const fixture = scratch({ files: { "a.txt": "base\n" } });
    const remote = scratchBareGitOrigin();
    fixture.jj(["bookmark", "create", "feature", "-r", "@-"]);
    fixture.jj(["git", "remote", "add", "origin", remote]);
    fixture.jj(["git", "push", "--remote", "origin", "--bookmark", "feature"]);
    writeFileSync(join(fixture.repoDir, "a.txt"), "keep\n");
    fixture.jj(["describe", "-m", "keep"]);
    const before = changeIdOf(fixture, "@");
    expect(
      spawnSync("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/feature"]).status,
    ).toBe(0);
    await jjPull(fixture.repoDir);
    expect(changeIdOf(fixture, "@")).toBe(before);
    expect(readFileSync(join(fixture.repoDir, "a.txt"), "utf8")).toBe("keep\n");
  });

  it("reports configured ambiguous remotes without choosing one and Fetch names the candidates", async () => {
    const fixture = scratch({ colocate: false, files: { "a.txt": "base\n" } });
    fixture.jj(["git", "remote", "add", "upstream", scratchBareGitOrigin()]);
    fixture.jj(["git", "remote", "add", "fork", scratchBareGitOrigin()]);
    await expect(getJjStatus(fixture.repoDir)).resolves.toMatchObject({
      hasRemote: true,
      remoteUrl: null,
    });
    await expect(jjPull(fixture.repoDir)).rejects.toThrow(/Multiple git remotes.*fork.*upstream/);
  });
});

describeIfJj("durable native change checkpoint", () => {
  it("keeps the described message on Finish and journals retained heads outside .jj", async () => {
    const fixture = scratch({ colocate: false, files: { "a.txt": "a\n" } });
    const context = { paseoHome: join(fixture.dir, "home") };
    writeFileSync(join(fixture.repoDir, "a.txt"), "edited\n");
    const before = await getJjChangeMeta(fixture.repoDir, "@");
    expect(before).not.toBeNull();
    await jjDescribe(
      fixture.repoDir,
      { message: "My full description\n\nDetails", expectedChangeId: before!.changeId },
      context,
    );
    await jjCommit(fixture.repoDir, { message: "" }, context);
    const finished = await getJjChangeMeta(fixture.repoDir, "@-");
    expect(finished!.description.trim()).toBe("My full description\n\nDetails");
    const { readJjCheckpoint, jjCheckpointPath } = await import("./jj-checkpoint.js");
    const checkpoint = await readJjCheckpoint(fixture.repoDir, context.paseoHome);
    expect(checkpoint!.completedChanges.map((head) => head.changeId)).toEqual([before!.changeId]);
    expect(checkpoint!.operations.map((operation) => operation.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(checkpoint!.recoveryPins).toHaveLength(4);
    // Live bookmarks follow native rewrites. The retained recovery coordinate
    // is the pin at its captured full operation, not a promise of a frozen live ref.
    const captured = checkpoint!.operations[0]!;
    expect(fixture.jj(["util", "gc", "--expire", "now"]).status).toBe(0);
    expect(
      fixture
        .jj([
          "--at-op",
          captured.beforeOperation,
          "log",
          "--no-graph",
          "-r",
          `bookmarks(exact:"${captured.recoveryPin}")`,
          "-T",
          "commit_id",
        ])
        .stdout.trim(),
    ).toBe(before!.commitId);

    expect(jjCheckpointPath(fixture.repoDir, context.paseoHome).startsWith(context.paseoHome)).toBe(
      true,
    );
  });

  it("New retains the previous native selection as durable WIP", async () => {
    const fixture = scratch({ colocate: false, files: { "file.txt": "base\n" } });
    const context = { paseoHome: join(fixture.dir, "home") };
    writeFileSync(join(fixture.repoDir, "file.txt"), "saved unfinished work\n");
    const before = (await getJjChangeMeta(fixture.repoDir, "@"))!;
    await jjNew(fixture.repoDir, { expectedChangeId: before.changeId }, context);
    const { readJjCheckpoint } = await import("./jj-checkpoint.js");
    expect((await readJjCheckpoint(fixture.repoDir, context.paseoHome))!.savedWip).toEqual([
      { commitId: before.commitId, changeId: before.changeId },
    ]);
    expect((await getJjChangeMeta(fixture.repoDir, "@-"))!.changeId).toBe(before.changeId);
  });

  it("refuses a changed draft and an excluded file without losing disk bytes", async () => {
    const fixture = scratch({ colocate: false });
    const context = { paseoHome: join(fixture.dir, "home") };
    const old = await getJjChangeMeta(fixture.repoDir, "@");
    fixture.jj(["new"]);
    await expect(
      jjDescribe(
        fixture.repoDir,
        { message: "old draft", expectedChangeId: old!.changeId },
        context,
      ),
    ).rejects.toThrow("changed since this form opened");
    await expect(
      jjDescribe(fixture.repoDir, { message: "empty captured ID", expectedChangeId: "" }, context),
    ).rejects.toThrow("changed since this form opened");
    await expect(
      jjEdit(fixture.repoDir, { changeId: "", acknowledgeRewrites: true }, context),
    ).rejects.toThrow("full, stable change ID");
    const bytes = Buffer.alloc(1_200_000, 7);
    writeFileSync(join(fixture.repoDir, "too-large.bin"), bytes);
    await expect(jjCommit(fixture.repoDir, { message: "not included" }, context)).rejects.toThrow(
      "too-large.bin",
    );
    expect(readFileSync(join(fixture.repoDir, "too-large.bin"))).toEqual(bytes);
  });

  it("edits the same stable change ID, warns about descendants and retains WIP", async () => {
    const fixture = scratch({ colocate: false, files: { "a.txt": "a\n" } });
    const context = { paseoHome: join(fixture.dir, "home") };
    const selected = await getJjChangeMeta(fixture.repoDir, "@-");
    const before = await getJjChangeMeta(fixture.repoDir, "@");
    await expect(
      jjEdit(fixture.repoDir, { changeId: selected!.changeId }, context),
    ).rejects.toThrow("native rewrite warning");
    await jjEdit(
      fixture.repoDir,
      { changeId: selected!.changeId, acknowledgeRewrites: true },
      context,
    );
    const current = await getJjChangeMeta(fixture.repoDir, "@");
    expect(current!.changeId).toBe(selected!.changeId);
    writeFileSync(join(fixture.repoDir, "a.txt"), "native rewritten\n");
    await jjDescribe(
      fixture.repoDir,
      { message: "same ID", expectedChangeId: selected!.changeId, acknowledgeRewrites: true },
      context,
    );
    expect((await getJjChangeMeta(fixture.repoDir, "@"))!.changeId).toBe(selected!.changeId);
    const { readJjCheckpoint } = await import("./jj-checkpoint.js");
    const checkpoint = await readJjCheckpoint(fixture.repoDir, context.paseoHome);
    expect(checkpoint!.savedWip).toEqual([
      { commitId: before!.commitId, changeId: before!.changeId },
    ]);
    expect(checkpoint!.operations[0]!.affectedHeads).toContainEqual({
      commitId: before!.commitId,
      changeId: before!.changeId,
    });
  });
  it("requires shared-head approval even without descendants and preserves both workspace change IDs", async () => {
    const fixture = scratch({ colocate: false });
    const context = { paseoHome: join(fixture.dir, "home") };
    const head = (await getJjChangeMeta(fixture.repoDir, "@"))!;
    const secondary = join(fixture.dir, "shared-workspace");
    expect(fixture.jj(["workspace", "add", secondary, "--name", "shared", "-r", "@-"]).status).toBe(
      0,
    );
    expect(fixture.jj(["edit", head.commitId], secondary).status).toBe(0);
    await expect(
      jjDescribe(fixture.repoDir, { message: "shared native description" }, context),
    ).rejects.toThrow("shared workspaces");
    await jjDescribe(
      fixture.repoDir,
      { message: "shared native description", acknowledgeRewrites: true },
      context,
    );
    expect((await getJjChangeMeta(fixture.repoDir, "@"))!.changeId).toBe(head.changeId);
    expect(fixture.jj(["workspace", "update-stale"], secondary).status).toBe(0);
    const shared = (await getJjChangeMeta(secondary, "@"))!;
    expect(shared.changeId).toBe(head.changeId);
    expect(shared.description.trim()).toBe("shared native description");
    const { readJjCheckpoint } = await import("./jj-checkpoint.js");
    const operation = (await readJjCheckpoint(fixture.repoDir, context.paseoHome))!.operations[0]!;
    expect(operation.target!.changeId).toBe(head.changeId);
    expect(operation.impact).toEqual({ otherWorkspaces: 1, published: false });
  });

  it("honors native immutable protection and keeps the refusal journal/pins", async () => {
    const fixture = scratch({ colocate: false, files: { "a.txt": "a\n" } });
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    expect(
      fixture.jj(["config", "set", "--repo", 'revset-aliases."immutable_heads()"', "main"]).status,
    ).toBe(0);
    const selected = (await getJjChangeMeta(fixture.repoDir, "main"))!;
    const before = (await getJjChangeMeta(fixture.repoDir, "@"))!;
    const context = { paseoHome: join(fixture.dir, "home") };
    await expect(
      jjEdit(fixture.repoDir, { changeId: selected.changeId, acknowledgeRewrites: true }, context),
    ).rejects.toThrow(/immutable/);
    expect((await getJjChangeMeta(fixture.repoDir, "@"))!.changeId).toBe(before.changeId);
    const { readJjCheckpoint } = await import("./jj-checkpoint.js");
    const checkpoint = (await readJjCheckpoint(fixture.repoDir, context.paseoHome))!;
    expect(checkpoint.operations[0]!.status).toBe("refused");
    expect(checkpoint.recoveryPins).toHaveLength(3);
  });

  it("reports Finish's partial Describe→New failure and blocks publication without undo", async () => {
    const fixture = scratch({ colocate: false, files: { "a.txt": "a\n" } });
    const { runJjCommand } = await import("./run-jj-command.js");
    const { readJjCheckpoint } = await import("./jj-checkpoint.js");
    const context = {
      paseoHome: join(fixture.dir, "home"),
      runJjCommand: async (args: string[], options: Parameters<typeof runJjCommand>[1]) => {
        if (args[0] === "new")
          return {
            stdout: "",
            stderr: "controlled New failure",
            exitCode: 1,
            signal: null,
            truncated: false,
          };
        return runJjCommand(args, options);
      },
    };
    const before = (await getJjChangeMeta(fixture.repoDir, "@"))!;
    await expect(
      jjCommit(fixture.repoDir, { message: "retained partial description" }, context),
    ).rejects.toThrow("controlled New failure");
    const after = (await getJjChangeMeta(fixture.repoDir, "@"))!;
    expect(after.changeId).toBe(before.changeId);
    expect(after.description.trim()).toBe("retained partial description");
    const checkpoint = (await readJjCheckpoint(fixture.repoDir, context.paseoHome))!;
    expect(checkpoint.operations[0]!.status).toBe("reconciliation_required");
    expect(checkpoint.operations[0]!.after!.changeId).toBe(before.changeId);
    await expect(jjPush(fixture.repoDir, context)).rejects.toThrow("Publication is blocked");
    await expect(
      jjDescribe(fixture.repoDir, { message: "cannot erase partial result" }, context),
    ).rejects.toThrow("previous jj operation requires reconciliation");
  });

  it("requires reconciliation if checkpoint state disappears or live ownership changes", async () => {
    const fixture = scratch({ colocate: false });
    const context = { paseoHome: join(fixture.dir, "home") };
    await jjDescribe(fixture.repoDir, { message: "saved" }, context);
    const { jjCheckpointPath } = await import("./jj-checkpoint.js");
    rmSync(jjCheckpointPath(fixture.repoDir, context.paseoHome));
    await expect(
      jjDescribe(fixture.repoDir, { message: "must not adopt" }, context),
    ).rejects.toThrow("saved jj checkpoint");
    expect((await getJjChangeMeta(fixture.repoDir, "@"))!.description.trim()).toBe("saved");
  });

  it("refuses to recreate lost checkpoint-directory state while its live reference survives", async () => {
    const fixture = scratch({ colocate: false });
    const context = { paseoHome: join(fixture.dir, "home") };
    await jjDescribe(fixture.repoDir, { message: "saved before storage loss" }, context);
    rmSync(join(context.paseoHome, "projects", "jj-checkpoints"), { recursive: true });
    await expect(
      jjDescribe(fixture.repoDir, { message: "must not recreate" }, context),
    ).rejects.toThrow("saved jj checkpoint is missing");
    expect((await getJjChangeMeta(fixture.repoDir, "@"))!.description.trim()).toBe(
      "saved before storage loss",
    );
  });
  it("refuses checkpoint adoption by a replacement native store at the same external path", async () => {
    const fixture = scratch({ colocate: false });
    const context = { paseoHome: join(fixture.dir, "home") };
    await jjDescribe(fixture.repoDir, { message: "old repository state" }, context);
    rmSync(join(fixture.repoDir, ".jj"), { recursive: true });
    expect(fixture.jj(["git", "init"]).status).toBe(0);
    await expect(
      jjDescribe(fixture.repoDir, { message: "must not adopt" }, context),
    ).rejects.toThrow("unavailable in this jj store");
    expect((await getJjChangeMeta(fixture.repoDir, "@"))!.description.trim()).toBe("");
  });
});
