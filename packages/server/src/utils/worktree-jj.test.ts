import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  createJjWorktree,
  deleteJjPaseoWorktree,
  JjUnregisteredWorkspaceError,
  JjUnsnapshottedFilesError,
  jjRevisionResolves,
  listJjPaseoWorktrees,
  PrimaryWorkspaceDeleteError,
  restoreJjWorkspace,
  rollbackJjWorkspace,
  runJjWorkspaceSafe,
} from "./worktree-jj.js";
import {
  readJjWorkspaceIncarnation,
  writeJjWorkspaceIncarnation,
  writePaseoWorktreeMetadataFile,
  readPaseoWorktreeMetadata,
} from "./worktree-metadata.js";
import { withWorkspaceLifecycle, workspaceLifecycleKey } from "./workspace-lifecycle.js";
import { isPlatform } from "../test-utils/platform.js";
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
  it("creates a sibling from the current workspace parent without changing the current change", async () => {
    const fixture = createFixture({ colocate: false });
    fixture.jj(["new", "-m", "parent beyond main"]);
    fixture.jj(["new", "-m", "current work"]);
    writeFileSync(join(fixture.repoDir, "current.txt"), "keep current work\n");
    const current = fixture.jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]).stdout.trim();
    const parent = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "sibling",
      source: { kind: "branch-off", baseBranch: "@-", branchName: "sibling" },
      worktreesRoot: fixture.worktreesRoot,
    });
    expect(created.worktreePath).toBe(join(fixture.dir, "repo-sibling"));
    expect(
      fixture
        .jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"], created.worktreePath)
        .stdout.trim(),
    ).toBe(parent);
    expect(fixture.jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]).stdout.trim()).toBe(
      current,
    );
    expect(readFileSync(join(fixture.repoDir, "current.txt"), "utf8")).toBe("keep current work\n");
    expect(existsSync(join(created.worktreePath, "current.txt"))).toBe(false);
  });

  it("refuses an occupied sibling path on every retry without overwriting or suffixing", async () => {
    const fixture = createFixture({ colocate: false });
    const occupied = join(fixture.dir, "repo-collision");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep.txt"), "existing directory\n");
    const create = () =>
      createJjWorktree({
        cwd: fixture.repoDir,
        worktreeSlug: "collision",
        source: { kind: "branch-off", baseBranch: "@-" },
      });
    await expect(create()).rejects.toThrow(`Workspace path already exists: ${occupied}`);
    await expect(create()).rejects.toThrow(`Workspace path already exists: ${occupied}`);
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("existing directory\n");
    expect(existsSync(`${occupied}-1`)).toBe(false);
    expect(workspaceEntries(fixture).map((entry) => entry.name)).toEqual(["default"]);
  });

  it("creates a branch-off workspace with a feature bookmark at its head", async () => {
    const fixture = createFixture();

    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "feat-one",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/one" },
      paseoHome: fixture.worktreesRoot,
      worktreesRoot: fixture.worktreesRoot,
    });

    const expectedPath = join(fixture.dir, "repo-feat-one");
    expect(created.worktreePath).toBe(expectedPath);
    expect(created.branchName).toBe("feat/one");
    expect(existsSync(join(created.worktreePath, "readme.md"))).toBe(true);

    // Feature bookmark on the workspace head; base bookmark untouched.
    const wsHead = fixture
      .jj(["log", "--no-graph", "-r", "feat/one", "-T", "commit_id"])
      .stdout.trim();
    const wsAt = workspaceEntries(fixture).find((entry) => entry.name === "repo-feat-one");
    expect(wsHead).toBe(wsAt?.commitId);
    const mainStillAtBase = fixture
      .jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"])
      .stdout.trim();
    const baseCommit = fixture
      .jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
      .stdout.trim();
    expect(mainStillAtBase).toBe(baseCommit);

    // Metadata: readable through the jj-aware reader with the pinned base.
    const metadata = await readPaseoWorktreeMetadata(created.worktreePath);
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
    const metadata = await readPaseoWorktreeMetadata(created.worktreePath);
    expect(metadata?.baseRef).toBe(mainHead);
    // Workspace head is a child of the bookmark head; no new bookmark created.
    const parent = fixture
      .jj(["log", "--no-graph", "-r", "repo-on-main@-", "-T", "commit_id"])
      .stdout.trim();
    expect(parent).toBe(mainHead);
    const bookmarks = fixture.jj(["bookmark", "list"]).stdout;
    expect(bookmarks).not.toContain("repo-on-main");
  });

  it("pins the base so later bookmark movement cannot shift the recorded base", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "pinned",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/pinned" },
      worktreesRoot: fixture.worktreesRoot,
    });
    const recordedBase = (await readPaseoWorktreeMetadata(created.worktreePath))?.baseRef;

    // Move main far forward in the primary.
    fixture.jj(["new", "main", "-m", "moved"]);
    fixture.jj(["bookmark", "set", "main"]);

    const metadataAfter = await readPaseoWorktreeMetadata(created.worktreePath);
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
    expect(paths).toEqual([join(fixture.dir, "repo-listed-a"), join(fixture.dir, "repo-listed-b")]);
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
    fixture.jj(["describe", "-m", "precious work", "-r", "repo-doomed@"]);

    const persistedPins: string[] = [];
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      worktreesRoot: fixture.worktreesRoot,
      persistRecoveryPin: async (pin) => {
        persistedPins.push(pin);
      },
    });

    expect(persistedPins).toEqual([
      expect.stringMatching(/^paseo\/recovery\/repo-doomed-[a-f0-9-]+$/),
    ]);
    expect(existsSync(created.worktreePath)).toBe(false);
    expect(workspaceEntries(fixture).map((entry) => entry.name)).not.toContain("repo-doomed");
    expect(await jjRevisionResolves(fixture.repoDir, persistedPins[0] ?? "")).toBe(true);

    // Restore at the pin: the pinned change becomes the workspace's parent.
    await restoreJjWorkspace({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      workspaceName: "repo-doomed",
      revision: persistedPins[0] ?? "",
    });
    const restoredParent = fixture
      .jj(["log", "--no-graph", "-r", persistedPins[0]!, "-T", "commit_id"])
      .stdout.trim();
    const wsParent = fixture
      .jj(["log", "--no-graph", "-r", "repo-doomed@-", "-T", "commit_id"])
      .stdout.trim();
    expect(wsParent).toBe(restoredParent);
    const description = fixture
      .jj(["log", "--no-graph", "-r", persistedPins[0]!, "-T", "description"])
      .stdout.trim();
    expect(description).toBe("precious work");
  });

  it("blocks deletion when jj refuses to snapshot workspace files", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "unsnapshotted",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/unsnapshotted" },
      worktreesRoot: fixture.worktreesRoot,
    });

    // A file over snapshot.max-new-file-size is refused by jj (verified on
    // 0.45.1): it would be LOST by forget+remove, so deletion must block.
    writeFileSync(join(created.worktreePath, "huge.bin"), Buffer.alloc(1024 * 1024 + 64, 1));

    await expect(
      deleteJjPaseoWorktree({
        cwd: fixture.repoDir,
        worktreePath: created.worktreePath,
        worktreesRoot: fixture.worktreesRoot,
      }),
    ).rejects.toBeInstanceOf(JjUnsnapshottedFilesError);
    expect(existsSync(created.worktreePath)).toBe(true);
    expect(workspaceEntries(fixture).map((entry) => entry.name)).toContain("repo-unsnapshotted");
  });

  it("moves an existing recovery pin to the new head instead of failing open", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "repin",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/repin" },
      worktreesRoot: fixture.worktreesRoot,
    });

    // First archive pins and persists; restore brings the workspace back with
    // the OLD pin still present.
    const pins: string[] = [];
    const incarnation = (await readJjWorkspaceIncarnation(created.worktreePath))!;
    const metadata = (await readPaseoWorktreeMetadata(created.worktreePath))!;
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      worktreesRoot: fixture.worktreesRoot,
      persistRecoveryPin: async (pin) => {
        pins.push(pin);
      },
    });
    await restoreJjWorkspace({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      workspaceName: "repo-repin",
      revision: pins[0] ?? "",
    });
    // The recovery service reapplies retained incarnation and checkpoint metadata.
    await writeJjWorkspaceIncarnation(created.worktreePath, incarnation);
    await writePaseoWorktreeMetadataFile(created.worktreePath, metadata);
    // A later archive gets its own pin; the previous generation stays intact.
    writeFileSync(join(created.worktreePath, "second-round.txt"), "work\n");
    fixture.jj(["describe", "-m", "second round", "-r", "repo-repin@"]);

    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      worktreesRoot: fixture.worktreesRoot,
      persistRecoveryPin: async (pin) => {
        pins.push(pin);
      },
    });
    expect(pins).toHaveLength(2);
    expect(pins[1]).not.toBe(pins[0]);
    const pinnedHead = fixture
      .jj(["log", "--no-graph", "-r", pins[1]!, "-T", "description.first_line()"])
      .stdout.trim();
    expect(pinnedHead).toBe("second round");
  });

  it("records and honors managed bookmark ownership (review fix 7)", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "owned",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/owned" },
      worktreesRoot: fixture.worktreesRoot,
    });

    const metadata = await readPaseoWorktreeMetadata(created.worktreePath);
    expect(metadata?.version).toBe(2);
    expect(metadata?.version === 2 ? metadata.jjBookmark : null).toBe("feat/owned");

    // An alias bookmark on the same head must NOT null the managed owner.
    fixture.jj(["bookmark", "create", "alias", "-r", "repo-owned@"]);
    const { getJjWorkspaceBookmark } = await import("./checkout-jj.js");
    await expect(
      getJjWorkspaceBookmark(created.worktreePath, { worktreesRoot: fixture.worktreesRoot }),
    ).resolves.toBe("feat/owned");
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
    expect(workspaceEntries(fixture).map((entry) => entry.name)).toContain("repo-kept");
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
    fixture.jj(["rebase", "-s", "repo-staleable@", "-d", "root()"]);

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
    const metadata = await readPaseoWorktreeMetadata(created.worktreePath);
    expect(metadata?.baseRefName).toBe("main");
    const listed = await listJjPaseoWorktrees({
      cwd: fixture.repoDir,
      worktreesRoot: fixture.worktreesRoot,
    });
    expect(listed.map((entry) => entry.path)).toContain(created.worktreePath);
  });

  it("refuses PR creation without a forge remote before creating a workspace", async () => {
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
    ).rejects.toMatchObject({ code: "workspace_source_unavailable" });
  });

  it("retains the directory when the workspace is no longer registered (fail closed)", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "externally-forgotten",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/forgotten" },
      worktreesRoot: fixture.worktreesRoot,
    });
    writeFileSync(join(created.worktreePath, "uncommitted.txt"), "never snapshotted\n");
    // External forget (user CLI, partial failure, truncated list) — the
    // directory survives with unpinable content.
    fixture.jj(["workspace", "forget", "repo-externally-forgotten"]);

    await expect(
      deleteJjPaseoWorktree({
        cwd: fixture.repoDir,
        worktreePath: created.worktreePath,
        worktreesRoot: fixture.worktreesRoot,
      }),
    ).rejects.toThrow(JjUnregisteredWorkspaceError);
    expect(existsSync(created.worktreePath)).toBe(true);
    expect(existsSync(join(created.worktreePath, "uncommitted.txt"))).toBe(true);
  });

  it("quarantines instead of deleting: the directory is preserved under .quarantine", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "quarantined",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/quarantined" },
      worktreesRoot: fixture.worktreesRoot,
    });

    let reportedQuarantine = "";
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      worktreesRoot: fixture.worktreesRoot,
      reportQuarantine: (path) => {
        reportedQuarantine = path;
      },
      persistRecoveryPin: async () => {
        // This write is deliberately AFTER the final snapshot and pin.
        writeFileSync(join(created.worktreePath, "racing-write.txt"), "written after snapshot\n");
      },
    });

    expect(existsSync(created.worktreePath)).toBe(false);
    expect(workspaceEntries(fixture).map((entry) => entry.name)).not.toContain("repo-quarantined");
    const quarantineRoot = join(fixture.worktreesRoot, ".quarantine");
    const files = readdirSync(quarantineRoot, { recursive: true }).map(String);
    const preserved = files.filter((path) => path.endsWith("racing-write.txt"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(reportedQuarantine, "racing-write.txt"), "utf8")).toBe(
      "written after snapshot\n",
    );
    expect(readFileSync(join(quarantineRoot, preserved[0]!), "utf8")).toBe(
      "written after snapshot\n",
    );
  });

  it("captures teardown writes in the recovery pin before forgetting a native workspace", async () => {
    const fixture = createFixture({ colocate: false });
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "teardown-write",
      worktreesRoot: fixture.worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/teardown" },
    });
    const script =
      "require('fs').writeFileSync('teardown.txt', process.env.PASEO_SOURCE_CHECKOUT_PATH)";
    writeFileSync(
      join(created.worktreePath, "paseo.json"),
      JSON.stringify({ worktree: { teardown: [`"${process.execPath}" -e "${script}"`] } }),
    );
    let pin = "";
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      worktreesRoot: fixture.worktreesRoot,
      persistRecoveryPin: async (value) => {
        pin = value;
      },
    });
    expect(fixture.jj(["file", "show", "-r", pin, "teardown.txt"]).stdout).toBe(fixture.repoDir);
  });

  it("refuses concurrent mutations for a workspace under deletion (barrier)", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "barrier-ws",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/barrier" },
      worktreesRoot: fixture.worktreesRoot,
    });
    writeFileSync(join(created.worktreePath, "work.txt"), "dirty\n");

    // The deletion transaction is held open by a gate we control; code OUTSIDE
    // its async context (what a concurrent session call would be) must see
    // all commands refused (reads snapshot too).
    const { withJjDeletionTransaction, JjMutationBarrierError, runJjCommand } =
      await import("./run-jj-command.js");
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const transaction = withJjDeletionTransaction(created.worktreePath, () => gate);

    await expect(
      runJjCommand(["describe", "-m", "concurrent"], { cwd: created.worktreePath }),
    ).rejects.toBeInstanceOf(JjMutationBarrierError);
    await expect(
      runJjCommand(["log", "-r", "@", "--no-graph"], { cwd: created.worktreePath }),
    ).rejects.toBeInstanceOf(JjMutationBarrierError);

    releaseGate();
    await transaction;
    // After the transaction settles, mutations flow again.
    await runJjCommand(["describe", "-m", "after"], { cwd: created.worktreePath });
  });

  it("rollback forgets the workspace but retains and reports the created bookmark", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "rolled-back",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/rolled-back" },
      worktreesRoot: fixture.worktreesRoot,
    });

    const retained: string[] = [];
    await rollbackJjWorkspace(fixture.repoDir, "repo-rolled-back", created.worktreePath, {
      createdBookmark: created.jjCreatedBookmark,
      logger: {
        warn: (info: { retainedBookmark: string }) => {
          retained.push(info.retainedBookmark);
        },
      },
    });
    expect(retained).toEqual(["feat/rolled-back"]);

    expect(workspaceEntries(fixture).map((entry) => entry.name)).not.toContain("repo-rolled-back");
    expect(existsSync(created.worktreePath)).toBe(false);
    expect(await jjRevisionResolves(fixture.repoDir, "feat/rolled-back")).toBe(true);
  });
});

describeIfJj("jj rollback ownership guard", () => {
  it("preserves a created bookmark subsequently moved by a user", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "moved",
      worktreesRoot: fixture.worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/moved" },
    });
    fixture.jj(["bookmark", "move", "--allow-backwards", "feat/moved", "--to", "main"]);
    await rollbackJjWorkspace(fixture.repoDir, "repo-moved", created.worktreePath, {
      createdBookmark: created.jjCreatedBookmark,
    });
    expect(await jjRevisionResolves(fixture.repoDir, "feat/moved")).toBe(true);
    expect(workspaceEntries(fixture).map((entry) => entry.name)).not.toContain("repo-moved");
    expect(existsSync(created.worktreePath)).toBe(false);
  });
});

describeIfJj("jj retained rollback artifacts and lifecycle aliases", () => {
  it("preserves an externally moved bookmark at the rollback cleanup boundary", async () => {
    const fixture = createFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "late-move",
      worktreesRoot: fixture.worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/late-move" },
    });
    const remote = join(fixture.dir, "local-origin.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    expect(fixture.jj(["git", "remote", "add", "origin", remote]).status).toBe(0);
    expect(fixture.jj(["describe", "-m", "owned work"], created.worktreePath).status).toBe(0);
    expect(
      fixture.jj(["git", "push", "--remote", "origin", "--bookmark", "feat/late-move"]).status,
    ).toBe(0);
    let adoptedRemoteState = "";
    const userTarget = fixture
      .jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"])
      .stdout.trim();
    expect(userTarget).not.toBe(created.jjCreatedBookmark!.target);
    const retained: string[] = [];
    await rollbackJjWorkspace(fixture.repoDir, "repo-late-move", created.worktreePath, {
      createdBookmark: created.jjCreatedBookmark,
      logger: {
        warn: (info: { retainedBookmark: string }) => {
          retained.push(info.retainedBookmark);
          // External jj adopts the ref after forget, immediately before cleanup.
          fixture.jj([
            "bookmark",
            "move",
            "--allow-backwards",
            "feat/late-move",
            "--to",
            userTarget,
          ]);
          adoptedRemoteState = fixture.jj(["bookmark", "list", "--all-remotes"]).stdout;
        },
      },
    });
    expect(retained).toEqual(["feat/late-move"]);
    expect(adoptedRemoteState).toContain("@origin");
    expect(fixture.jj(["bookmark", "list", "--all-remotes"]).stdout).toBe(adoptedRemoteState);
    expect(
      fixture
        .jj(["log", "--no-graph", "-r", 'bookmarks(exact:"feat/late-move")', "-T", "commit_id"])
        .stdout.trim(),
    ).toBe(userTarget);
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("retains both targets of an externally conflicted created bookmark", async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.repoDir, "user.txt"), "user work\n");
    fixture.jj(["describe", "-m", "user work"]);
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "conflicted-ref",
      worktreesRoot: fixture.worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/conflicted" },
    });
    const originalTarget = created.jjCreatedBookmark!.target;
    const userTarget = fixture
      .jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"])
      .stdout.trim();
    fixture.jj(["bookmark", "delete", "feat/conflicted"]);
    const fork = fixture.jj(["op", "log", "--no-graph", "-n", "1", "-T", "id"]).stdout.trim();
    fixture.jj(["bookmark", "create", "feat/conflicted", "--revision", originalTarget]);
    fixture.jj([
      "bookmark",
      "create",
      "feat/conflicted",
      "--revision",
      userTarget,
      "--at-operation",
      fork,
    ]);
    const targets = () =>
      fixture
        .jj([
          "log",
          "--no-graph",
          "-r",
          'bookmarks(exact:"feat/conflicted")',
          "-T",
          'commit_id ++ "\\n"',
        ])
        .stdout.trim()
        .split("\n")
        .sort();
    expect(targets()).toEqual([originalTarget, userTarget].sort());
    const refState = fixture.jj(["bookmark", "list", "--all-remotes"]).stdout;
    await rollbackJjWorkspace(fixture.repoDir, "repo-conflicted-ref", created.worktreePath, {
      createdBookmark: created.jjCreatedBookmark,
    });
    expect(targets()).toEqual([originalTarget, userTarget].sort());
    expect(fixture.jj(["bookmark", "list", "--all-remotes"]).stdout).toBe(refState);
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it.skipIf(isPlatform("win32"))(
    "canonicalizes absent backing roots through parent aliases and releases failure",
    async () => {
      const fixture = createFixture();
      const alias = join(fixture.dir, "alias");
      symlinkSync(fixture.dir, alias, "dir");
      const root = join(fixture.dir, "absent", "workspace");
      const aliasRoot = join(alias, "absent", "workspace");
      expect(await workspaceLifecycleKey(root)).toBe(await workspaceLifecycleKey(aliasRoot));
      const entered = Promise.withResolvers<void>();
      const finishFirst = Promise.withResolvers<void>();
      const events: string[] = [];
      async function nestedOperation() {
        events.push("nested");
      }
      const first = withWorkspaceLifecycle(root, async () => {
        events.push("first");
        entered.resolve();
        await finishFirst.promise;
        // Re-entry must not deadlock behind a waiter queued by another caller.
        await withWorkspaceLifecycle(aliasRoot, nestedOperation);
        throw new Error("failed lifecycle");
      });
      const rejected = expect(first).rejects.toThrow("failed lifecycle");
      await entered.promise;
      const second = withWorkspaceLifecycle(aliasRoot, async () => {
        events.push("second");
      });
      expect(events).toEqual(["first"]);
      finishFirst.resolve();
      await rejected;
      await second;
      expect(events).toEqual(["first", "nested", "second"]);
    },
  );
});

describe("jj workspace name from path", () => {
  it("derives the workspace name from the directory basename", async () => {
    const { workspaceNameFromPath } = await import("./worktree-jj.js");
    expect(await workspaceNameFromPath("/tmp/worktrees/hash/feat-one")).toBe("feat-one");
    expect(await workspaceNameFromPath("/tmp/worktrees/hash/feat-one-1")).toBe("feat-one-1");
  });
});

describeIfJj("jj exact base cardinality", () => {
  it("refuses multi-result bases without allocating a checkout or bookmark", async () => {
    const fixture = createFixture({ colocate: false });
    const before = workspaceEntries(fixture);
    await expect(
      createJjWorktree({
        cwd: fixture.repoDir,
        worktreeSlug: "ambiguous",
        source: { kind: "branch-off", baseBranch: "all()", branchName: "ambiguous" },
        worktreesRoot: fixture.worktreesRoot,
        runSetup: false,
      }),
    ).rejects.toThrow("Cannot resolve jj revision for base");
    expect(workspaceEntries(fixture)).toEqual(before);
    expect(
      fixture.jj(["log", "--no-graph", "-r", 'bookmarks(exact:"ambiguous")', "-T", "commit_id"])
        .stdout,
    ).toBe("");
  });
});
