import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  createJjWorktree,
  deleteJjPaseoWorktree,
  getJjPaseoWorktreesRoot,
  jjRevisionResolves,
  listJjPaseoWorktrees,
  PrimaryWorkspaceDeleteError,
  recoveryPinName,
  restoreJjWorkspace,
  runJjWorkspaceSafe,
} from "./worktree-jj.js";
import { readPaseoWorktreeMetadata } from "./worktree-metadata.js";
import { createScratchJjRepo, isJjAvailable } from "../test-utils/jj.js";

const describeIfJj = describe.skipIf(!isJjAvailable());

const disposables: Array<() => void> = [];

afterAll(() => {
  for (const dispose of disposables.splice(0)) {
    dispose();
  }
});

interface JjWorktreeFixture {
  repoDir: string;
  dir: string;
  worktreesRoot: string;
  jj: (args: string[], cwd?: string) => { stdout: string; status: number | null };
  dispose: () => void;
}

function createFixture(options?: { colocate?: boolean }): JjWorktreeFixture {
  const fixture = createScratchJjRepo({
    colocate: options?.colocate ?? true,
    files: { "readme.md": "hello\n" },
  });
  disposables.push(fixture.dispose);
  const base = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);
  const baseCommit = base.stdout.trim();
  fixture.jj(["bookmark", "create", "main", "-r", baseCommit]);
  const worktreesRoot = join(fixture.dir, "worktrees-home");
  mkdirSync(worktreesRoot, { recursive: true });
  return {
    repoDir: fixture.repoDir,
    dir: fixture.dir,
    worktreesRoot,
    jj: (args, cwd) => fixture.jj(args, cwd ?? fixture.repoDir),
    dispose: fixture.dispose,
  };
}

function workspaceEntries(
  fixture: JjWorktreeFixture,
): Array<{ name: string; root: string; commitId: string }> {
  const result = fixture.jj([
    "workspace",
    "list",
    "-T",
    'name ++ "\\t" ++ root ++ "\\t" ++ target.commit_id() ++ "\\t" ++ target.change_id() ++ "\\t" ++ ' +
      'if(target.empty(), "empty", "nonempty") ++ "\\n"',
  ]);
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, root, commitId] = line.split("\t");
      return { name, root, commitId };
    });
}

describeIfJj("jj workspaces as Paseo worktrees", () => {
  it("creates a branch-off workspace with a feature bookmark at its head", async () => {
    const fixture = createFixture();

    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "feat-one",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/one" },
      paseoHome: fixture.worktreesRoot,
      worktreesRoot: fixture.worktreesRoot,
    });

    const expectedPath = join(
      await getJjPaseoWorktreesRoot(fixture.repoDir, {
        worktreesRoot: fixture.worktreesRoot,
      }),
      "feat-one",
    );
    expect(created.worktreePath).toBe(expectedPath);
    expect(created.branchName).toBe("feat/one");
    expect(existsSync(join(created.worktreePath, "readme.md"))).toBe(true);

    // Feature bookmark on the workspace head; base bookmark untouched.
    const wsHead = fixture
      .jj(["log", "--no-graph", "-r", "feat/one", "-T", "commit_id"])
      .stdout.trim();
    const wsAt = workspaceEntries(fixture).find((entry) => entry.name === "feat-one");
    expect(wsHead).toBe(wsAt?.commitId);
    const mainStillAtBase = fixture
      .jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"])
      .stdout.trim();
    const baseCommit = fixture
      .jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
      .stdout.trim();
    expect(mainStillAtBase).toBe(baseCommit);

    // Metadata: readable through the jj-aware reader with the pinned base.
    const metadata = readPaseoWorktreeMetadata(created.worktreePath);
    expect(metadata?.baseRefName).toBe("main");
    expect(metadata?.baseRef).toBe(baseCommit);
  });

  it("creates a checkout-branch workspace at the existing bookmark without a new one", async () => {
    const fixture = createFixture();
    fixture.jj(["new", "main", "-m", "work on main line"]);
    fixture.jj(["bookmark", "set", "main"]); // move main forward
    const mainHead = fixture
      .jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"])
      .stdout.trim();

    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "on-main",
      source: { kind: "checkout-branch", branchName: "main" },
      worktreesRoot: fixture.worktreesRoot,
    });

    expect(created.branchName).toBe("main");
    const metadata = readPaseoWorktreeMetadata(created.worktreePath);
    expect(metadata?.baseRef).toBe(mainHead);
    // Workspace head is a child of the bookmark head; no new bookmark created.
    const parent = fixture
      .jj(["log", "--no-graph", "-r", "on-main@-", "-T", "commit_id"])
      .stdout.trim();
    expect(parent).toBe(mainHead);
    const bookmarks = fixture.jj(["bookmark", "list"]).stdout;
    expect(bookmarks).not.toContain("on-main");
  });

  it("pins the base so later bookmark movement cannot shift the recorded base", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "pinned",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/pinned" },
      worktreesRoot: fixture.worktreesRoot,
    });
    const recordedBase = readPaseoWorktreeMetadata(created.worktreePath)?.baseRef;

    // Move main far forward in the primary.
    fixture.jj(["new", "main", "-m", "moved"]);
    fixture.jj(["bookmark", "set", "main"]);

    const metadataAfter = readPaseoWorktreeMetadata(created.worktreePath);
    expect(metadataAfter?.baseRef).toBe(recordedBase);
    const resolves = await jjRevisionResolves(fixture.repoDir, recordedBase ?? "");
    expect(resolves).toBe(true);
  });

  it("lists only Paseo-owned workspaces and skips the primary", async () => {
    const fixture = createFixture();
    await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "listed-a",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/listed-a" },
      worktreesRoot: fixture.worktreesRoot,
    });
    await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "listed-b",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/listed-b" },
      worktreesRoot: fixture.worktreesRoot,
    });
    // A workspace OUTSIDE the worktrees root is not Paseo-owned.
    const outside = join(fixture.dir, "outside-ws");
    fixture.jj(["workspace", "add", outside, "--name", "outside", "--revision", "main"]);

    const listed = await listJjPaseoWorktrees({
      cwd: fixture.repoDir,
      worktreesRoot: fixture.worktreesRoot,
    });
    const paths = listed.map((entry) => entry.path).sort();
    expect(paths).toEqual([
      join(
        await getJjPaseoWorktreesRoot(fixture.repoDir, { worktreesRoot: fixture.worktreesRoot }),
        "listed-a",
      ),
      join(
        await getJjPaseoWorktreesRoot(fixture.repoDir, { worktreesRoot: fixture.worktreesRoot }),
        "listed-b",
      ),
    ]);
    for (const entry of listed) {
      expect(entry.head).toMatch(/^[0-9a-f]+$/);
      expect(entry.createdAt).toBeDefined();
    }
    rmSync(outside, { recursive: true, force: true });
    fixture.jj(["workspace", "forget", "outside"]);
  });

  it("refuses to delete the primary workspace", async () => {
    const fixture = createFixture();
    await expect(
      deleteJjPaseoWorktree({
        cwd: fixture.repoDir,
        worktreePath: fixture.repoDir,
        worktreesRoot: fixture.worktreesRoot,
      }),
    ).rejects.toBeInstanceOf(PrimaryWorkspaceDeleteError);
  });

  it("deletes through the recovery-pin sequence: pin, persist, forget, remove", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "doomed",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/doomed" },
      worktreesRoot: fixture.worktreesRoot,
    });
    // Give the workspace some described work so the pin holds real content.
    fixture.jj(["describe", "-m", "precious work", "-r", "doomed@"]);

    const persistedPins: string[] = [];
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      worktreesRoot: fixture.worktreesRoot,
      persistRecoveryPin: async (pin) => {
        persistedPins.push(pin);
      },
    });

    expect(persistedPins).toEqual([recoveryPinName("doomed")]);
    expect(existsSync(created.worktreePath)).toBe(false);
    expect(workspaceEntries(fixture).map((entry) => entry.name)).not.toContain("doomed");
    expect(await jjRevisionResolves(fixture.repoDir, persistedPins[0] ?? "")).toBe(true);

    // Restore at the pin: the pinned change becomes the workspace's parent.
    await restoreJjWorkspace({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      workspaceName: "doomed",
      revision: persistedPins[0] ?? "",
    });
    const restoredParent = fixture
      .jj(["log", "--no-graph", "-r", "paseo/recovery/doomed", "-T", "commit_id"])
      .stdout.trim();
    const wsParent = fixture
      .jj(["log", "--no-graph", "-r", "doomed@-", "-T", "commit_id"])
      .stdout.trim();
    expect(wsParent).toBe(restoredParent);
    const description = fixture
      .jj(["log", "--no-graph", "-r", "paseo/recovery/doomed", "-T", "description"])
      .stdout.trim();
    expect(description).toBe("precious work");
  });

  it("aborts deletion with nothing removed when pin persistence fails", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "kept",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/kept" },
      worktreesRoot: fixture.worktreesRoot,
    });

    await expect(
      deleteJjPaseoWorktree({
        cwd: fixture.repoDir,
        worktreePath: created.worktreePath,
        worktreesRoot: fixture.worktreesRoot,
        persistRecoveryPin: async () => {
          throw new Error("registry write failed");
        },
      }),
    ).rejects.toThrow("registry write failed");

    expect(existsSync(created.worktreePath)).toBe(true);
    expect(workspaceEntries(fixture).map((entry) => entry.name)).toContain("kept");
  });

  it("recovers from a stale working copy via update-stale", async () => {
    const fixture = createFixture();
    // A bookmarkless workspace (checkout-branch creates no feature bookmark)
    // keeps the stale trigger free of bookmark-divergence noise.
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "staleable",
      source: { kind: "checkout-branch", branchName: "main" },
      worktreesRoot: fixture.worktreesRoot,
    });

    // Uncommitted work in the workspace (snapshotted into its @).
    writeFileSync(join(created.worktreePath, "new-file.txt"), "work\n");
    fixture.jj(["status"], created.worktreePath);

    // Rewrite the workspace's checked-out commit from the primary → stale.
    fixture.jj(["rebase", "-s", "staleable@", "-d", "root()"]);

    // A plain command would fail with "The working copy is stale"; the safe
    // wrapper refreshes and retries, and the workspace command succeeds.
    const result = await runJjWorkspaceSafe(["status"], { cwd: created.worktreePath });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/working copy is stale/i);
    expect(result.stdout).toContain("Working copy");
  });

  it("supports native (non-colocated) repositories", async () => {
    const fixture = createFixture({ colocate: false });
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "native-ws",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/native" },
      worktreesRoot: fixture.worktreesRoot,
    });
    expect(existsSync(join(created.worktreePath, ".jj"))).toBe(true);
    const metadata = readPaseoWorktreeMetadata(created.worktreePath);
    expect(metadata?.baseRefName).toBe("main");
    const listed = await listJjPaseoWorktrees({
      cwd: fixture.repoDir,
      worktreesRoot: fixture.worktreesRoot,
    });
    expect(listed.map((entry) => entry.path)).toContain(created.worktreePath);
  });

  it("rejects deferred worktree sources before spawning", async () => {
    const fixture = createFixture();
    await expect(
      createJjWorktree({
        cwd: fixture.repoDir,
        worktreeSlug: "pr-ws",
        source: {
          kind: "checkout-github-pr",
          githubPrNumber: 7,
          headRef: "refs/heads/x",
          baseRefName: "main",
        },
        worktreesRoot: fixture.worktreesRoot,
      }),
    ).rejects.toThrow(/not supported on jj/i);
  });
});

describe("jj workspace name from path", () => {
  it("derives the workspace name from the directory basename", async () => {
    const { workspaceNameFromPath } = await import("./worktree-jj.js");
    expect(workspaceNameFromPath("/tmp/worktrees/hash/feat-one")).toBe("feat-one");
    expect(workspaceNameFromPath("/tmp/worktrees/hash/feat-one-1")).toBe("feat-one-1");
  });
});
