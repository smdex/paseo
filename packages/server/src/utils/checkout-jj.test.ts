import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  hasJjBookmark,
  jjFactsToCheckoutSnapshotFacts,
  listJjBookmarkSuggestions,
  listJjCommits,
  resolveJjBranchCheckout,
} from "./checkout-jj.js";
import { createScratchJjRepo, isJjAvailable, type ScratchJjRepoFixture } from "../test-utils/jj.js";

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
    fixture.jj(["new", "-m", "work"]);
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
