import { execFileSync } from "node:child_process";
import { createWorkspaceRecoveryService } from "../workspace-recovery/workspace-recovery-service.js";
import { archiveByScope, type ArchiveDependencies } from "../../workspace-archive-service.js";
import { withWorkspaceLifecycle } from "../../../utils/workspace-lifecycle.js";
import { resolveJjRepoIdentity } from "../../../utils/vcs-backend.js";
import {
  readPaseoWorktreeMetadata,
  readJjWorkspaceIncarnation,
  updatePaseoWorktreeJjBookmark,
} from "../../../utils/worktree-metadata.js";
import { createScratchJjRepo, isJjAvailable } from "../../../test-utils/jj.js";
import { createJjWorktree } from "../../../utils/worktree-jj.js";
import os from "node:os";
import path from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";

import { afterEach, beforeEach, expect, test } from "vitest";

import { getCheckoutStatus } from "../../../utils/checkout-git.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  createNoGitWorkspaceRuntimeSnapshot,
  createNoopWorkspaceGitService,
} from "../../test-utils/workspace-git-service-stub.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  createPersistedWorkspaceRecord,
  clearWorkspaceRecoveryReference,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import { checkoutLiteFromGitSnapshot } from "../../workspace-registry-model.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import {
  createWorkspaceProvisioningService,
  WorkspaceProvisioningError,
  type WorkspaceProvisioningService,
} from "./workspace-provisioning-service.js";

// Real file-backed registries + a fake git-service port (the only dependency that
// shells out to git in production). No module mocks — the service is exercised
// through the same interface its callers in session.ts use.

const logger = createTestLogger();
const ARCHIVED_AT = "2026-01-01T00:00:00.000Z";
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

// The real filesystem, so "this directory is gone" is observed rather than modelled.
async function isDirectory(target: string): Promise<boolean> {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

let tmpDir: string;
let gitRoots: Set<string>;
let gitBranches: Map<string, string | null>;
let checkoutFailure: Error | null;
let restoredMergedChangeRequestUrl: string | null;
let workspaceRegistry: FileBackedWorkspaceRegistry;
let projectRegistry: FileBackedProjectRegistry;
let provisioning: WorkspaceProvisioningService;

function gitService() {
  return createNoopWorkspaceGitService({
    getSnapshot: async (cwd: string) => {
      const snapshot = createNoGitWorkspaceRuntimeSnapshot(cwd);
      if (!restoredMergedChangeRequestUrl) return snapshot;
      return {
        ...snapshot,
        forge: {
          ...snapshot.forge,
          featuresEnabled: true,
          pullRequest: {
            url: restoredMergedChangeRequestUrl,
            title: "Merged change request",
            state: "merged",
            baseRefName: "main",
            headRefName: "workspace-archive-latch",
            isMerged: true,
          },
        },
      };
    },
    getCheckout: async (cwd: string) => {
      if (checkoutFailure) throw checkoutFailure;
      let worktreeRoot: string | null = null;
      for (const root of gitRoots) {
        if (
          (cwd === root || cwd.startsWith(`${root}${path.sep}`)) &&
          root.length > (worktreeRoot?.length ?? -1)
        ) {
          worktreeRoot = root;
        }
      }
      return {
        cwd,
        isGit: worktreeRoot !== null,
        currentBranch: worktreeRoot ? (gitBranches.get(worktreeRoot) ?? "main") : null,
        remoteUrl: null,
        worktreeRoot,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      };
    },
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-provisioning-"));
  gitRoots = new Set();
  gitBranches = new Map();
  checkoutFailure = null;
  restoredMergedChangeRequestUrl = null;
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(tmpDir, "projects", "workspaces.json"),
    logger,
  );
  projectRegistry = new FileBackedProjectRegistry(
    path.join(tmpDir, "projects", "projects.json"),
    logger,
  );
  await workspaceRegistry.initialize();
  await projectRegistry.initialize();
  provisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    isDirectory,
    logger,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("fresh git repo creates a workspace at the canonical worktree root", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const workspace = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(workspace.cwd).toBe(repo);
  expect(await workspaceRegistry.list()).toHaveLength(1);
  expect(await projectRegistry.list()).toHaveLength(1);
});

test("fresh non-git directory creates a directory workspace at the exact path", async () => {
  const dir = path.join(tmpDir, "plain");

  const workspace = await provisioning.findOrCreateWorkspaceForDirectory(dir);

  expect(workspace.cwd).toBe(dir);
});

test("background workspace creation preserves hooks, inheritance and durable visibility", async () => {
  const dir = path.join(tmpDir, "plain");
  const events: string[] = [];
  provisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    isDirectory,
    logger,
    lifecycle: {
      emit: (name) => {
        events.push(name);
      },
      before: async (_name, request) => request,
    },
  });
  const parent = await provisioning.createWorkspaceForDirectory(dir, null, undefined, {
    background: true,
  });
  const child = await provisioning.createWorkspaceForDirectory(dir, null, undefined, {
    callerWorkspaceId: parent.workspaceId,
  });
  const visible = await provisioning.createWorkspaceForDirectory(dir, null, undefined, {
    callerWorkspaceId: parent.workspaceId,
    background: false,
  });
  const human = await provisioning.createWorkspaceForDirectory(dir);
  expect(parent.background).toBe(true);
  expect(child.background).toBe(true);
  expect(visible.background).toBe(false);
  expect(human.background).toBe(false);
  expect(events).toEqual(Array(4).fill("workspace.create.after"));
  const reloaded = new FileBackedWorkspaceRegistry(
    path.join(tmpDir, "projects", "workspaces.json"),
    logger,
  );
  await reloaded.initialize();
  expect((await reloaded.get(child.workspaceId))?.background).toBe(true);
});

test("re-opening an active workspace by exact path returns the same record without duplicating", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  const second = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(second.workspaceId).toBe(first.workspaceId);
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("re-opening Windows-equivalent workspace cwd spellings reuses the active and archived record", async () => {
  const cwd = path.join(tmpDir, "workspace");
  const created = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  await workspaceRegistry.upsert({ ...created, cwd: `${cwd}${path.sep}` });

  const active = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  expect(active.workspaceId).toBe(created.workspaceId);
  expect(await workspaceRegistry.list()).toHaveLength(1);

  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  expect(reopened).toMatchObject({ workspaceId: created.workspaceId, archivedAt: null });
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("re-opening refreshes mutable checkout metadata without renaming the workspace", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  const first = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.upsert({ ...first, title: "Pinned work" });
  gitRoots.add(repo);
  gitBranches.set(repo, "feature/refresh");

  const refreshed = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(refreshed).toMatchObject({
    workspaceId: first.workspaceId,
    kind: "local_checkout",
    branch: "feature/refresh",
    displayName: first.displayName,
    title: "Pinned work",
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  });
  expect(await workspaceRegistry.get(first.workspaceId)).toEqual(refreshed);
  expect((await projectRegistry.get(first.projectId))?.kind).toBe("git");
});

test("persists manual worktree ownership separately from its workspace kind", async () => {
  const cwd = path.join(tmpDir, "manual-worktree");
  const mainRepoRoot = path.join(tmpDir, "main-repo");
  const manualWorktreeProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    isDirectory,
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async () => ({
        cwd,
        isGit: true,
        currentBranch: "feature/manual",
        remoteUrl: null,
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot,
      }),
    }),
  });

  const workspace = await manualWorktreeProvisioning.findOrCreateWorkspaceForDirectory(cwd);

  expect(workspace).toMatchObject({
    kind: "worktree",
    isPaseoOwnedWorktree: false,
    mainRepoRoot,
  });
});

test("re-opening an archived workspace by its exact path unarchives it and keeps the id", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);

  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened.workspaceId).toBe(created.workspaceId);
  expect(reopened.archivedAt).toBeNull();
});

test("default directory open skips archived background workspaces while explicit recovery preserves their visibility", async () => {
  const cwd = path.join(tmpDir, "repo");
  mkdirSync(cwd, { recursive: true });
  const background = await provisioning.createWorkspaceForDirectory(cwd, undefined, undefined, {
    background: true,
  });
  await workspaceRegistry.archive(background.workspaceId, ARCHIVED_AT);

  const opened = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  expect(opened).toMatchObject({ background: false, archivedAt: null });
  expect(opened.workspaceId).not.toBe(background.workspaceId);
  const archived = await workspaceRegistry.get(background.workspaceId);
  expect(archived).toMatchObject({ background: true, archivedAt: ARCHIVED_AT });
  const recovered = await provisioning.ensureWorkspaceRecordUnarchived(archived!);
  expect(recovered).toMatchObject({
    workspaceId: background.workspaceId,
    background: true,
    archivedAt: null,
  });
  expect((await provisioning.findOrCreateWorkspaceForDirectory(cwd)).workspaceId).toBe(
    opened.workspaceId,
  );
});

test("reopening archived exact-root records restores the fresh Git project", async () => {
  const cwd = path.join(tmpDir, "repo");
  mkdirSync(cwd, { recursive: true });
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: cwd,
    kind: "non_git",
    displayName: "repo",
    timestamp: ARCHIVED_AT,
  });
  await projectRegistry.upsert({
    ...project,
    projectKey: "remote:github.com/acme/old-repo",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-archived-root",
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "repo",
    createdAt: ARCHIVED_AT,
    updatedAt: ARCHIVED_AT,
    archivedAt: ARCHIVED_AT,
  });
  await workspaceRegistry.upsert(workspace);
  await projectRegistry.archive(project.projectId, ARCHIVED_AT);
  const archivedProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    isDirectory,
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async () => ({
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/new-repo.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    }),
  });

  const reopened = await archivedProvisioning.ensureWorkspaceRecordUnarchived(workspace);

  expect(reopened).toMatchObject({
    workspaceId: workspace.workspaceId,
    kind: "local_checkout",
    archivedAt: null,
  });
  expect(await projectRegistry.get(project.projectId)).toMatchObject({
    kind: "git",
    projectKey: "remote:github.com/acme/new-repo",
    archivedAt: null,
  });
});

test("uses one workspace snapshot when reopening an archived workspace", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);

  const archived = (await workspaceRegistry.list()).filter(
    (workspace) => workspace.workspaceId === created.workspaceId,
  );
  let reads = 0;
  const snapshotRegistry: WorkspaceRegistry = {
    initialize: () => workspaceRegistry.initialize(),
    existsOnDisk: () => workspaceRegistry.existsOnDisk(),
    list: async () => (reads++ === 0 ? archived : []),
    get: (workspaceId) => workspaceRegistry.get(workspaceId),
    update: (workspaceId, updater) => workspaceRegistry.update(workspaceId, updater),
    upsert: (workspace) => workspaceRegistry.upsert(workspace),
    archive: (workspaceId, archivedAt) => workspaceRegistry.archive(workspaceId, archivedAt),
    remove: (workspaceId) => workspaceRegistry.remove(workspaceId),
  };
  const snapshotProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry: snapshotRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    isDirectory,
  });

  const reopened = await snapshotProvisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({ workspaceId: created.workspaceId, archivedAt: null });
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("reopening an archived workspace refreshes placement without renaming it", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.upsert({ ...created, title: "Pinned archived work" });
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  gitRoots.delete(repo);

  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({
    workspaceId: created.workspaceId,
    projectId: created.projectId,
    title: "Pinned archived work",
    kind: "directory",
    branch: null,
    displayName: created.displayName,
    archivedAt: null,
  });
  expect(reopened.updatedAt).toEqual(expect.any(String));
  expect(await workspaceRegistry.get(created.workspaceId)).toEqual(reopened);
});

function realGitProvisioning(): WorkspaceProvisioningService {
  return createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    logger,
    isDirectory,
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async (cwd) => {
        const status = await getCheckoutStatus(cwd, { logger, paseoHome: tmpDir });
        return checkoutLiteFromGitSnapshot(
          cwd,
          status.isGit
            ? status
            : {
                isGit: false,
                currentBranch: null,
                remoteUrl: null,
                repoRoot: null,
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
        );
      },
    }),
  });
}

test.each(["active", "archived"] as const)(
  "reopening an %s ordinary Git subproject reconciles Git-to-directory conversion",
  async (state) => {
    const repo = path.join(tmpDir, "repo");
    const cwd = path.join(repo, "sub");
    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main", repo], { stdio: "pipe" });
    const file = path.join(cwd, "saved.txt");
    writeFileSync(file, "preserved subproject work\n");
    const service = realGitProvisioning();
    const created = await service.findOrCreateWorkspaceForDirectory(cwd);
    expect(created).toMatchObject({
      cwd,
      kind: "local_checkout",
      worktreeRoot: repo,
      isPaseoOwnedWorktree: false,
    });
    await workspaceRegistry.update(created.workspaceId, (current) => ({
      ...current,
      title: "Pinned subproject",
      baseBranch: "main",
    }));
    if (state === "archived") await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
    renameSync(path.join(repo, ".git"), path.join(tmpDir, "retained-git"));

    const reopened = await service.findOrCreateWorkspaceForDirectory(cwd);

    expect(reopened).toMatchObject({
      workspaceId: created.workspaceId,
      projectId: created.projectId,
      cwd,
      kind: "directory",
      branch: null,
      worktreeRoot: null,
      mainRepoRoot: null,
      isPaseoOwnedWorktree: false,
      displayName: created.displayName,
      title: "Pinned subproject",
      baseBranch: "main",
      archivedAt: null,
    });
    expect(await workspaceRegistry.get(created.workspaceId)).toEqual(reopened);
    expect((await projectRegistry.get(created.projectId))?.kind).toBe("non_git");
    expect(await workspaceRegistry.list()).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe("preserved subproject work\n");
    expect(existsSync(path.join(tmpDir, "retained-git", "HEAD"))).toBe(true);
    expect((await service.findOrCreateWorkspaceForDirectory(cwd)).workspaceId).toBe(
      created.workspaceId,
    );
  },
);

test.each(["active", "archived"] as const)(
  "reopening an %s ordinary Git subproject reconciles a nearer repository boundary",
  async (state) => {
    const repo = path.join(tmpDir, "repo");
    const nestedRepo = path.join(repo, "nested");
    const cwd = path.join(nestedRepo, "sub");
    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main", repo], { stdio: "pipe" });
    const file = path.join(cwd, "saved.txt");
    writeFileSync(file, "preserved nested work\n");
    const service = realGitProvisioning();
    const created = await service.findOrCreateWorkspaceForDirectory(cwd);
    expect(created.worktreeRoot).toBe(repo);
    if (state === "archived") await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
    execFileSync("git", ["init", "--initial-branch=nested-main", nestedRepo], { stdio: "pipe" });
    execFileSync("git", ["-C", nestedRepo, "add", "sub/saved.txt"], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        nestedRepo,
        "-c",
        "user.name=Provisioning Test",
        "-c",
        "user.email=provisioning@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Initial nested checkout",
      ],
      { stdio: "pipe" },
    );

    const reopened = await service.findOrCreateWorkspaceForDirectory(cwd);

    expect(reopened).toMatchObject({
      workspaceId: created.workspaceId,
      projectId: created.projectId,
      cwd,
      kind: "local_checkout",
      branch: "nested-main",
      worktreeRoot: nestedRepo,
      mainRepoRoot: null,
      isPaseoOwnedWorktree: false,
      displayName: created.displayName,
      archivedAt: null,
    });
    expect(await workspaceRegistry.get(created.workspaceId)).toEqual(reopened);
    expect((await projectRegistry.get(created.projectId))?.rootPath).toBe(cwd);
    expect(await workspaceRegistry.list()).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe("preserved nested work\n");
    expect((await service.findOrCreateWorkspaceForDirectory(cwd)).workspaceId).toBe(
      created.workspaceId,
    );
  },
);

test("opening a subpath of an archived git workspace mints a fresh workspace at the exact subpath", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const canonical = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(canonical.workspaceId, ARCHIVED_AT);
  const sub = path.join(repo, "packages", "app");

  const fresh = await provisioning.findOrCreateWorkspaceForDirectory(sub);

  expect(fresh.cwd).toBe(sub);
  expect(fresh.workspaceId).not.toBe(canonical.workspaceId);
  expect((await workspaceRegistry.get(canonical.workspaceId))?.archivedAt).toBe(ARCHIVED_AT);
});

test("ensureWorkspaceRecordUnarchived restores the owning archived project with the workspace", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await projectRegistry.archive(created.projectId, ARCHIVED_AT);

  const unarchived = await provisioning.ensureWorkspaceRecordUnarchived({
    ...created,
    archivedAt: ARCHIVED_AT,
  });

  expect(unarchived.archivedAt).toBeNull();
  expect((await workspaceRegistry.get(created.workspaceId))?.archivedAt).toBeNull();
  expect((await projectRegistry.get(created.projectId))?.archivedAt).toBeNull();
});

test("ensureWorkspaceRecordUnarchived preserves the consumed auto-archive change request", async () => {
  const repo = path.join(tmpDir, "repo");
  const changeRequestUrl = "https://github.com/getpaseo/paseo/pull/2714";
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT, {
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
  const archivedWorkspace = await workspaceRegistry.get(created.workspaceId);

  const unarchived = await provisioning.ensureWorkspaceRecordUnarchived(archivedWorkspace!);

  expect(unarchived).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
  expect(await workspaceRegistry.get(created.workspaceId)).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
});

test("ensureWorkspaceRecordUnarchived acknowledges a merged change request for a legacy archive", async () => {
  const repo = path.join(tmpDir, "repo");
  const changeRequestUrl = "https://github.com/getpaseo/paseo/pull/2714";
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  const archivedWorkspace = await workspaceRegistry.get(created.workspaceId);
  restoredMergedChangeRequestUrl = changeRequestUrl;

  const unarchived = await provisioning.ensureWorkspaceRecordUnarchived(archivedWorkspace!);

  expect(unarchived).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
  expect(await workspaceRegistry.get(created.workspaceId)).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
});

test("ensureWorkspaceRecordUnarchived refreshes the latch for a different merged change request", async () => {
  const repo = path.join(tmpDir, "repo");
  const previousChangeRequestUrl = "https://github.com/getpaseo/paseo/pull/2713";
  const currentChangeRequestUrl = "https://github.com/getpaseo/paseo/pull/2714";
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT, {
    autoArchivedChangeRequestUrl: previousChangeRequestUrl,
  });
  const archivedWorkspace = await workspaceRegistry.get(created.workspaceId);
  restoredMergedChangeRequestUrl = currentChangeRequestUrl;

  const unarchived = await provisioning.ensureWorkspaceRecordUnarchived(archivedWorkspace!);

  expect(unarchived).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: currentChangeRequestUrl,
  });
  expect(await workspaceRegistry.get(created.workspaceId)).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: currentChangeRequestUrl,
  });
});

test("does not unarchive either record when checkout refresh fails", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await projectRegistry.archive(created.projectId, ARCHIVED_AT);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  const archivedProject = await projectRegistry.get(created.projectId);
  const archivedWorkspace = await workspaceRegistry.get(created.workspaceId);
  checkoutFailure = new Error("Git read failed");

  await expect(provisioning.ensureWorkspaceRecordUnarchived(archivedWorkspace!)).rejects.toThrow(
    "Git read failed",
  );

  expect(await projectRegistry.get(created.projectId)).toEqual(archivedProject);
  expect(await workspaceRegistry.get(created.workspaceId)).toEqual(archivedWorkspace);
});

test("resolveOrCreateWorkspaceIdForCreateAgent returns a created worktree's id without touching the registry", async () => {
  // The branch only reads workspace.workspaceId off the worktree result.
  const createdWorktree = {
    workspace: { workspaceId: "ws-from-worktree" },
  } as unknown as CreatePaseoWorktreeWorkflowResult;

  const id = await provisioning.resolveOrCreateWorkspaceIdForCreateAgent({
    createdWorktree,
    cwd: path.join(tmpDir, "x"),
    initialTitle: null,
  });

  expect(id).toBe("ws-from-worktree");
  expect(await workspaceRegistry.list()).toHaveLength(0);
});

test("resolveOrCreateWorkspaceIdForCreateAgent honors an explicitly requested workspace id", async () => {
  const id = await provisioning.resolveOrCreateWorkspaceIdForCreateAgent({
    createdWorktree: null,
    requestedWorkspaceId: "ws-requested",
    cwd: path.join(tmpDir, "x"),
    initialTitle: null,
  });

  expect(id).toBe("ws-requested");
  expect(await workspaceRegistry.list()).toHaveLength(0);
});

test("resolveOrCreateWorkspaceIdForCreateAgent creates a titled workspace when nothing is provided", async () => {
  const dir = path.join(tmpDir, "plain");

  const id = await provisioning.resolveOrCreateWorkspaceIdForCreateAgent({
    createdWorktree: null,
    cwd: dir,
    initialTitle: "My Title",
  });

  const created = await workspaceRegistry.get(id);
  expect(created?.cwd).toBe(dir);
  expect(created?.title).toBe("My Title");
});

test("createWorkspaceForDirectory always mints a fresh workspace even when one already occupies the cwd", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.createWorkspaceForDirectory(repo);
  const second = await provisioning.createWorkspaceForDirectory(repo);

  expect(second.workspaceId).not.toBe(first.workspaceId);
  expect(await workspaceRegistry.list()).toHaveLength(2);
});

test("directory creation persists the live branch and a trimmed title", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const workspace = await provisioning.createWorkspaceForDirectory(repo, "  Focused work  ");
  expect(workspace).toMatchObject({ branch: "main", title: "Focused work" });
});

test("createWorkspaceForDirectory honors an explicit active project without cwd containment", async () => {
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: path.join(tmpDir, "elsewhere"),
    kind: "non_git",
    displayName: "elsewhere",
    timestamp: "2026-03-01T00:00:00.000Z",
  });
  const workspace = await provisioning.createWorkspaceForDirectory(
    path.join(tmpDir, "directory"),
    null,
    project.projectId,
  );
  expect(workspace.projectId).toBe(project.projectId);
});

test("createWorkspaceForDirectory refreshes an explicit project's stale Git kind", async () => {
  const rootPath = path.join(tmpDir, "repo");
  gitRoots.add(rootPath);
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath,
    kind: "non_git",
    displayName: "Saved project name",
    timestamp: ARCHIVED_AT,
  });
  await projectRegistry.upsert({ ...project, customName: "Pinned project name" });

  const workspace = await provisioning.createWorkspaceForDirectory(
    rootPath,
    null,
    project.projectId,
  );

  expect(workspace.projectId).toBe(project.projectId);
  expect(await projectRegistry.get(project.projectId)).toMatchObject({
    projectId: project.projectId,
    rootPath,
    kind: "git",
    displayName: "Saved project name",
    customName: "Pinned project name",
  });
});

test("createWorkspaceForDirectory classifies unknown and archived explicit projects", async () => {
  await expect(
    provisioning.createWorkspaceForDirectory(path.join(tmpDir, "directory"), null, "missing"),
  ).rejects.toMatchObject({
    code: "unknown_project",
  } satisfies Partial<WorkspaceProvisioningError>);
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: path.join(tmpDir, "archived"),
    kind: "non_git",
    displayName: "archived",
    timestamp: "2026-03-01T00:00:00.000Z",
  });
  await projectRegistry.archive(project.projectId, "2026-03-02T00:00:00.000Z");
  await expect(
    provisioning.createWorkspaceForDirectory(
      path.join(tmpDir, "directory"),
      null,
      project.projectId,
    ),
  ).rejects.toMatchObject({
    code: "archived_project",
  } satisfies Partial<WorkspaceProvisioningError>);
});

test("findOrCreateProjectForDirectory keeps nested selected roots independent", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.findOrCreateProjectForDirectory(repo);
  const second = await provisioning.findOrCreateProjectForDirectory(path.join(repo, "sub"));

  expect(second.projectId).not.toBe(first.projectId);
  expect(first.rootPath).toBe(repo);
  expect(second.rootPath).toBe(path.join(repo, "sub"));
  expect(await projectRegistry.list()).toHaveLength(2);
});

test("runInImportWorkspace uses an active requested workspace without creating another", async () => {
  const cwd = path.join(tmpDir, "requested");
  mkdirSync(cwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd, requestedWorkspaceId: workspace.workspaceId },
    async (target) => target.workspaceId,
  );

  expect(result).toEqual({ value: workspace.workspaceId, createdWorkspace: null });
  expect(await workspaceRegistry.list()).toEqual([workspace]);
});

test("runInImportWorkspace reuses an active workspace for an untargeted import", async () => {
  const cwd = path.join(tmpDir, "active-import");
  mkdirSync(cwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd },
    async (target) => target.workspaceId,
  );

  expect(result).toEqual({ value: workspace.workspaceId, createdWorkspace: null });
  expect(await workspaceRegistry.list()).toEqual([workspace]);
});

test("runInImportWorkspace unarchives a workspace for an untargeted import", async () => {
  const cwd = path.join(tmpDir, "archived-import");
  mkdirSync(cwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);
  await workspaceRegistry.archive(workspace.workspaceId, ARCHIVED_AT);

  const result = await provisioning.runInImportWorkspace(
    { cwd },
    async (target) => target.workspaceId,
  );

  expect(result).toEqual({ value: workspace.workspaceId, createdWorkspace: null });
  expect(await workspaceRegistry.get(workspace.workspaceId)).toMatchObject({
    workspaceId: workspace.workspaceId,
    archivedAt: null,
  });
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("runInImportWorkspace leaves a reused workspace intact when import fails", async () => {
  const cwd = path.join(tmpDir, "failed-active-import");
  mkdirSync(cwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);
  const project = await projectRegistry.get(workspace.projectId);

  await expect(
    provisioning.runInImportWorkspace({ cwd }, async () => {
      throw new Error("provider session is unavailable");
    }),
  ).rejects.toThrow("provider session is unavailable");

  expect(await workspaceRegistry.list()).toEqual([workspace]);
  expect(await projectRegistry.get(workspace.projectId)).toEqual(project);
});

test.each(["missing", "archived"] as const)(
  "runInImportWorkspace rejects a %s requested workspace before importing",
  async (state) => {
    const cwd = path.join(tmpDir, "unavailable-workspace");
    mkdirSync(cwd);
    const workspace = await provisioning.createWorkspaceForDirectory(cwd);
    if (state === "archived") {
      await workspaceRegistry.archive(workspace.workspaceId, ARCHIVED_AT);
    } else {
      await workspaceRegistry.remove(workspace.workspaceId);
    }
    let imported = false;

    await expect(
      provisioning.runInImportWorkspace(
        { cwd, requestedWorkspaceId: workspace.workspaceId },
        async () => {
          imported = true;
        },
      ),
    ).rejects.toThrow(`Workspace not found: ${workspace.workspaceId}`);
    expect(imported).toBe(false);
  },
);

test.each(["missing", "archived"] as const)(
  "runInImportWorkspace rejects a requested workspace whose project is %s before importing",
  async (state) => {
    const cwd = path.join(tmpDir, "unavailable-project");
    mkdirSync(cwd);
    const workspace = await provisioning.createWorkspaceForDirectory(cwd);
    if (state === "archived") {
      await projectRegistry.archive(workspace.projectId, ARCHIVED_AT);
    } else {
      await projectRegistry.remove(workspace.projectId);
    }
    let imported = false;

    await expect(
      provisioning.runInImportWorkspace(
        { cwd, requestedWorkspaceId: workspace.workspaceId },
        async () => {
          imported = true;
        },
      ),
    ).rejects.toThrow(`Project not found: ${workspace.projectId}`);
    expect(imported).toBe(false);
  },
);

test("runInImportWorkspace accepts a filesystem-equivalent requested cwd", async () => {
  const cwd = path.join(tmpDir, "real-directory");
  const alias = path.join(tmpDir, "directory-alias");
  mkdirSync(cwd);
  symlinkSync(cwd, alias, directorySymlinkType);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd: alias, requestedWorkspaceId: workspace.workspaceId },
    async (target) => target.workspaceId,
  );

  expect(result.value).toBe(workspace.workspaceId);
});

test("runInImportWorkspace rejects a requested workspace with a different cwd", async () => {
  const cwd = path.join(tmpDir, "workspace-directory");
  const otherCwd = path.join(tmpDir, "other-directory");
  mkdirSync(cwd);
  mkdirSync(otherCwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);
  let imported = false;

  await expect(
    provisioning.runInImportWorkspace(
      { cwd: otherCwd, requestedWorkspaceId: workspace.workspaceId },
      async () => {
        imported = true;
      },
    ),
  ).rejects.toThrow(`Import cwd does not match workspace: ${workspace.workspaceId}`);
  expect(imported).toBe(false);
});

test("runInImportWorkspace creates one fresh workspace for an untargeted import", async () => {
  const cwd = path.join(tmpDir, "fresh-import");
  mkdirSync(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd },
    async (workspace) => workspace.workspaceId,
  );

  expect(result.value).toBe(result.createdWorkspace?.workspaceId);
  expect(await workspaceRegistry.list()).toEqual([result.createdWorkspace]);
});

test.each(["missing", "archived"] as const)(
  "runInImportWorkspace restores the exact %s project state when an untargeted import fails",
  async (state) => {
    const cwd = path.join(tmpDir, `failed-import-${state}`);
    mkdirSync(cwd);
    let previousProject: PersistedProjectRecord | null = null;
    if (state === "archived") {
      const project = await provisioning.findOrCreateProjectForDirectory(cwd);
      await projectRegistry.archive(project.projectId, ARCHIVED_AT);
      previousProject = await projectRegistry.get(project.projectId);
    }

    await expect(
      provisioning.runInImportWorkspace({ cwd }, async () => {
        throw new Error("provider session is unavailable");
      }),
    ).rejects.toThrow("provider session is unavailable");

    expect(await workspaceRegistry.list()).toEqual([]);
    expect(await projectRegistry.list()).toEqual(previousProject ? [previousProject] : []);
  },
);

test("a failed import keeps an archived worktree's placement when its directory is gone", async () => {
  // The git port here is the production read: getCheckoutStatus against the real
  // filesystem, so "the worktree directory is gone" is observed, not modelled.
  const mainRepoRoot = path.join(tmpDir, "main-repo");
  mkdirSync(mainRepoRoot, { recursive: true });
  const worktreeCwd = path.join(tmpDir, "worktrees", "feature-example");
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: mainRepoRoot,
    kind: "git",
    displayName: "main-repo",
    timestamp: ARCHIVED_AT,
  });
  const archived = createPersistedWorkspaceRecord({
    workspaceId: "ws-archived-worktree",
    projectId: project.projectId,
    cwd: worktreeCwd,
    kind: "worktree",
    displayName: "feature/example",
    branch: "feature/example",
    worktreeRoot: worktreeCwd,
    baseBranch: "main",
    isPaseoOwnedWorktree: true,
    mainRepoRoot,
    createdAt: ARCHIVED_AT,
    updatedAt: ARCHIVED_AT,
    archivedAt: ARCHIVED_AT,
  });
  await workspaceRegistry.upsert(archived);
  const realCheckoutProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    logger,
    isDirectory,
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => {
        const status = await getCheckoutStatus(cwd, { logger });
        return checkoutLiteFromGitSnapshot(
          cwd,
          status.isGit
            ? {
                isGit: true,
                currentBranch: status.currentBranch,
                remoteUrl: status.remoteUrl,
                repoRoot: status.repoRoot,
                isPaseoOwnedWorktree: status.isPaseoOwnedWorktree,
                mainRepoRoot: status.mainRepoRoot,
              }
            : {
                isGit: false,
                currentBranch: null,
                remoteUrl: null,
                repoRoot: null,
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
        );
      },
    }),
  });

  await expect(
    realCheckoutProvisioning.runInImportWorkspace({ cwd: worktreeCwd }, async () => {
      throw new Error("provider resume failed");
    }),
  ).rejects.toThrow("provider resume failed");

  expect(await workspaceRegistry.get(archived.workspaceId)).toMatchObject({
    kind: "worktree",
    branch: "feature/example",
    worktreeRoot: worktreeCwd,
    mainRepoRoot,
    isPaseoOwnedWorktree: true,
  });
});

test("re-opening an active worktree workspace keeps its placement while the directory is away", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  gitBranches.set(repo, "feature/away");
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  expect(created).toMatchObject({ kind: "local_checkout", branch: "feature/away" });
  rmSync(repo, { recursive: true, force: true });
  gitRoots.delete(repo);

  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({
    workspaceId: created.workspaceId,
    kind: "local_checkout",
    branch: "feature/away",
  });
});

test("a directory that goes away while the git read is in flight keeps its placement", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  gitBranches.set(repo, "feature/vanishing");
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  expect(created).toMatchObject({ kind: "local_checkout", branch: "feature/vanishing" });
  const vanishingProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    isDirectory,
    logger,
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => {
        rmSync(repo, { recursive: true, force: true });
        return {
          cwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        };
      },
    }),
  });

  const reopened = await vanishingProvisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({
    workspaceId: created.workspaceId,
    kind: "local_checkout",
    branch: "feature/vanishing",
  });
});

for (const savedAuthority of [true, false]) {
  test.skipIf(!isJjAvailable())(
    `directory provisioning refuses an archived jj record at a replacement incarnation (saved authority=${savedAuthority})`,
    async () => {
      const fixture = createScratchJjRepo({ files: { "base.txt": "base\n" } });
      try {
        fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
        const created = await createJjWorktree({
          cwd: fixture.repoDir,
          worktreeSlug: "reused",
          worktreesRoot: path.join(tmpDir, "worktrees"),
          source: { kind: "branch-off", baseBranch: "main", branchName: "new-feature" },
        });
        const project = await projectRegistry.getOrCreateActiveByRoot({
          rootPath: fixture.repoDir,
          kind: "git",
          displayName: "project",
          timestamp: ARCHIVED_AT,
        });
        const saved = createPersistedWorkspaceRecord({
          workspaceId: "old",
          projectId: project.projectId,
          cwd: created.worktreePath,
          kind: "worktree",
          worktreeRoot: created.worktreePath,
          ...(savedAuthority
            ? { jjWorkspaceId: "old-incarnation", recoveryBookmark: "paseo/recovery/old" }
            : {}),
          displayName: "old",
          isPaseoOwnedWorktree: true,
          mainRepoRoot: fixture.repoDir,
          createdAt: ARCHIVED_AT,
          updatedAt: ARCHIVED_AT,
          archivedAt: ARCHIVED_AT,
        });
        await workspaceRegistry.upsert(saved);
        const head = fixture.jj(
          ["log", "--no-graph", "-r", "@", "-T", "commit_id"],
          created.worktreePath,
        ).stdout;
        await expect(
          provisioning.findOrCreateWorkspaceForDirectory(created.worktreePath),
        ).rejects.toThrow("different incarnation");
        expect(await workspaceRegistry.get("old")).toEqual(saved);
        expect(
          fixture.jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"], created.worktreePath)
            .stdout,
        ).toBe(head);
      } finally {
        fixture.dispose();
      }
    },
  );
}

interface JjOpenRaceFixture {
  fixture: ReturnType<typeof createScratchJjRepo>;
  old: Awaited<ReturnType<typeof createJjWorktree>>;
  a: PersistedWorkspaceRecord;
  b: PersistedWorkspaceRecord;
  provisioning: WorkspaceProvisioningService;
  archiveDeps: ArchiveDependencies;
  git: ReturnType<typeof createNoopWorkspaceGitService>;
  createReplacement: () => Promise<Awaited<ReturnType<typeof createJjWorktree>>>;
}

async function jjOpenRaceFixture(subproject: boolean): Promise<JjOpenRaceFixture> {
  const fixture = createScratchJjRepo({
    files: { "base.txt": "base\n", "sub/file.txt": "sub base\n" },
  });
  fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
  const worktreesRoot = path.join(tmpDir, "jj-worktrees");
  const old = await createJjWorktree({
    cwd: fixture.repoDir,
    worktreeSlug: "reused",
    worktreesRoot,
    source: { kind: "branch-off", baseBranch: "main", branchName: "old-feature" },
  });
  writeFileSync(path.join(old.worktreePath, "old-work.txt"), "saved old work\n");
  const git = createNoopWorkspaceGitService({
    getCheckout: async (cwd) => {
      const identity = resolveJjRepoIdentity(cwd);
      if (!identity) throw new Error(`Missing jj checkout: ${cwd}`);
      const metadata = readPaseoWorktreeMetadata(identity.workspaceRoot);
      return {
        cwd,
        isGit: true,
        currentBranch: metadata?.version === 2 ? (metadata.jjBookmark ?? null) : null,
        remoteUrl: null,
        worktreeRoot: identity.workspaceRoot,
        mainRepoRoot: identity.workspaceRoot === fixture.repoDir ? null : fixture.repoDir,
        isPaseoOwnedWorktree: identity.workspaceRoot !== fixture.repoDir,
      };
    },
    getSnapshot: async (cwd) => createNoGitWorkspaceRuntimeSnapshot(cwd),
  });
  const service = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: git,
    isDirectory,
    logger,
  });
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: fixture.repoDir,
    kind: "git",
    displayName: "jj",
    timestamp: ARCHIVED_AT,
  });
  const common = {
    sourceCwd: fixture.repoDir,
    projectId: project.projectId,
    repoRoot: fixture.repoDir,
    worktreeRoot: old.worktreePath,
    branch: "old-feature",
    baseBranch: "main",
    title: null,
  };
  const a = await service.createWorkspaceForWorktree({
    ...common,
    workspaceId: "a",
    cwd: subproject ? path.join(old.worktreePath, "sub") : old.worktreePath,
  });
  const b = await service.createWorkspaceForWorktree({
    ...common,
    workspaceId: "b",
    cwd: subproject ? old.worktreePath : path.join(old.worktreePath, "sub"),
  });
  await workspaceRegistry.archive(a.workspaceId, ARCHIVED_AT);
  const archiveDeps: ArchiveDependencies = {
    paseoHome: tmpDir,
    paseoWorktreesBaseRoot: worktreesRoot,
    github: { invalidate: () => {} },
    workspaceGitService: git,
    agentManager: {
      listAgents: () => [],
      getAgent: () => null,
      archiveAgent: async () => null,
      archiveSnapshot: async () => ({}),
    },
    agentStorage: { listByWorkspace: async () => [] },
    getWorkspace: (id) => workspaceRegistry.get(id),
    findWorkspaceIdForCwd: async (cwd) =>
      (await workspaceRegistry.list()).find((r) => r.cwd === cwd && !r.archivedAt)?.workspaceId ??
      null,
    findWorkspaceIdsForBackingPath: async (root) =>
      (await workspaceRegistry.list())
        .filter((r) => r.worktreeRoot === root)
        .map((r) => r.workspaceId),
    listActiveWorkspaces: async () => (await workspaceRegistry.list()).filter((r) => !r.archivedAt),
    archiveWorkspaceRecord: async (id) => {
      await workspaceRegistry.archive(id, ARCHIVED_AT);
    },
    setWorkspaceRecoveryPin: async (id, pin) => {
      await workspaceRegistry.update(id, (r) => ({ ...r, recoveryBookmark: pin }));
    },
    emitWorkspaceUpdatesForWorkspaceIds: async () => {},
    markWorkspaceArchiving: () => {},
    clearWorkspaceArchiving: () => {},
    killTerminalsForWorkspace: async () => {},
  };
  const createReplacement = () =>
    createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "reused",
      worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "new-feature" },
      onCreated: async (wt) => {
        await service.createWorkspaceForWorktree({
          ...common,
          workspaceId: "new",
          cwd: wt.worktreePath,
          worktreeRoot: wt.worktreePath,
          branch: wt.branchName,
          baseBranch: wt.comparisonBaseRef,
        });
      },
    });
  return { fixture, old, a, b, provisioning: service, archiveDeps, git, createReplacement };
}

for (const subproject of [false, true]) {
  test.skipIf(!isJjAvailable())(
    `jj directory open owns the backing root until durable unarchive (subproject=${subproject})`,
    async () => {
      const h = await jjOpenRaceFixture(subproject);
      const observed = Promise.withResolvers<void>();
      const finishOpen = Promise.withResolvers<void>();
      h.git.getSnapshot = async (cwd, options) => {
        if (options?.reason === "workspace-restore-auto-archive-latch") {
          observed.resolve();
          await finishOpen.promise;
        }
        return createNoGitWorkspaceRuntimeSnapshot(cwd);
      };
      const opening = h.provisioning.findOrCreateWorkspaceForDirectory(h.a.cwd);
      await observed.promise;
      let archiveEntered = false;
      const archiving = withWorkspaceLifecycle(h.old.worktreePath, async () => {
        archiveEntered = true;
        return archiveByScope(h.archiveDeps, {
          scope: { kind: "workspace", workspaceId: "b" },
          requestId: "race",
        });
      });
      try {
        expect((await workspaceRegistry.get("a"))?.archivedAt).toBe(ARCHIVED_AT);
        expect(archiveEntered).toBe(false);
        await workspaceRegistry.update("a", (record) => ({
          ...record,
          title: "Edited while opening",
        }));
        finishOpen.resolve();
        const reopened = await opening;
        expect(reopened.workspaceId).toBe("a");
        expect(reopened.archivedAt).toBeNull();
        expect(reopened.title).toBe("Edited while opening");
        expect((await archiving).removedDirectory).toBe(false);
        const fresh = await h.createReplacement();
        expect(fresh.worktreePath).toBe(`${h.old.worktreePath}-1`);
        expect(readFileSync(path.join(h.old.worktreePath, "old-work.txt"), "utf8")).toBe(
          "saved old work\n",
        );
        expect((await workspaceRegistry.get("a"))?.jjWorkspaceId).toBe(
          readJjWorkspaceIncarnation(h.old.worktreePath),
        );
      } finally {
        finishOpen.resolve();
        await Promise.allSettled([opening, archiving]);
        h.fixture.dispose();
      }
    },
  );

  test.skipIf(!isJjAvailable())(
    `jj directory open rereads archive authority when replacement wins ownership (subproject=${subproject})`,
    async () => {
      const h = await jjOpenRaceFixture(subproject);
      const stale = (await workspaceRegistry.get("a"))!;
      const startWinner = Promise.withResolvers<void>();
      const releaseWinner = Promise.withResolvers<void>();
      const winner = withWorkspaceLifecycle(h.old.worktreePath, async () => {
        await startWinner.promise;
        expect(
          (
            await archiveByScope(h.archiveDeps, {
              scope: { kind: "workspace", workspaceId: "b" },
              requestId: "winner",
            })
          ).removedDirectory,
        ).toBe(true);
        const fresh = await h.createReplacement();
        expect(fresh.worktreePath).toBe(h.old.worktreePath);
        releaseWinner.resolve();
      });
      const opening = h.provisioning.ensureWorkspaceRecordUnarchived(stale);
      const result = opening.then(
        () => null,
        (error: unknown) => error,
      );
      startWinner.resolve();
      try {
        await winner;
        await releaseWinner.promise;
        const saved = (await workspaceRegistry.get("a"))!;
        expect(saved.recoveryBookmark).toMatch(/^paseo\/recovery\//);
        expect(String(await result)).toContain("incarnation");
        expect(await workspaceRegistry.get("a")).toEqual(saved);
        expect(
          h.fixture.jj(["file", "show", "-r", saved.recoveryBookmark!, "old-work.txt"]).stdout,
        ).toBe("saved old work\n");
        expect(existsSync(path.join(h.old.worktreePath, "old-work.txt"))).toBe(false);
      } finally {
        await Promise.allSettled([winner, opening]);
        h.fixture.dispose();
      }
    },
  );
}

test.skipIf(!isJjAvailable())(
  "jj explicit recovery reenters provisioning ownership for root/subproject siblings",
  async () => {
    const h = await jjOpenRaceFixture(true);
    try {
      expect(
        (
          await archiveByScope(h.archiveDeps, {
            scope: { kind: "workspace", workspaceId: "b" },
            requestId: "archive",
          })
        ).removedDirectory,
      ).toBe(true);
      const recovery = createWorkspaceRecoveryService({
        paseoHome: tmpDir,
        worktreesRoot: path.join(tmpDir, "jj-worktrees"),
        getWorkspace: (id) => workspaceRegistry.get(id),
        getProject: (id) => projectRegistry.get(id),
        isDirectory,
        unarchiveWorkspace: async (record) => {
          await h.provisioning.ensureWorkspaceRecordUnarchived(record);
        },
        clearRecoveryPin: (id, pin) => clearWorkspaceRecoveryReference(workspaceRegistry, id, pin),
      });
      await expect(recovery.restore("a")).resolves.toEqual({ workspaceId: "a", action: "restore" });
      await expect(recovery.restore("b")).resolves.toEqual({
        workspaceId: "b",
        action: "unarchive",
      });
      expect((await workspaceRegistry.get("a"))?.recoveryBookmark).toBeNull();
      expect((await workspaceRegistry.get("b"))?.recoveryBookmark).toBeNull();
      expect(readFileSync(path.join(h.old.worktreePath, "old-work.txt"), "utf8")).toBe(
        "saved old work\n",
      );
    } finally {
      h.fixture.dispose();
    }
  },
);

for (const replacementBackend of ["jj", "git"]) {
  test.skipIf(!isJjAvailable())(
    `jj directory creation rejects a replacement during pre-acquisition observation (${replacementBackend})`,
    async () => {
      const h = await jjOpenRaceFixture(true);
      const atObservation = Promise.withResolvers<void>();
      const finishObservation = Promise.withResolvers<void>();
      const readCheckout = h.git.getCheckout;
      let gate = true;
      h.git.getCheckout = async (cwd) => {
        const observed = await readCheckout(cwd);
        if (cwd === h.a.cwd && gate) {
          gate = false;
          atObservation.resolve();
          await finishObservation.promise;
        }
        return observed;
      };
      const creating = h.provisioning.createWorkspaceForDirectory(h.a.cwd);
      const result = creating.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await atObservation.promise;
        expect(
          (
            await archiveByScope(h.archiveDeps, {
              scope: { kind: "workspace", workspaceId: "b" },
              requestId: "winner",
            })
          ).removedDirectory,
        ).toBe(true);
        const saved = (await workspaceRegistry.get("a"))!;
        if (replacementBackend === "jj") await h.createReplacement();
        else {
          mkdirSync(h.a.cwd, { recursive: true });
          execFileSync("git", ["init", h.old.worktreePath], { stdio: "pipe" });
        }
        finishObservation.resolve();
        expect(String(await result)).toContain("backend or incarnation changed");
        expect(await workspaceRegistry.get("a")).toEqual(saved);
        expect(
          h.fixture.jj(["file", "show", "-r", saved.recoveryBookmark!, "old-work.txt"]).stdout,
        ).toBe("saved old work\n");
      } finally {
        finishObservation.resolve();
        await Promise.allSettled([creating]);
        h.fixture.dispose();
      }
    },
  );
}

test.skipIf(!isJjAvailable())(
  "jj worktree provisioning rejects stale materialization after queued replacement",
  async () => {
    const h = await jjOpenRaceFixture(true);
    const startWinner = Promise.withResolvers<void>();
    const winner = withWorkspaceLifecycle(h.old.worktreePath, async () => {
      await startWinner.promise;
      await archiveByScope(h.archiveDeps, {
        scope: { kind: "workspace", workspaceId: "b" },
        requestId: "winner",
      });
      await h.createReplacement();
    });
    const creating = h.provisioning.createWorkspaceForWorktree({
      sourceCwd: h.fixture.repoDir,
      projectId: h.a.projectId,
      workspaceId: "misbound",
      repoRoot: h.fixture.repoDir,
      cwd: h.a.cwd,
      worktreeRoot: h.old.worktreePath,
      branch: "old-feature",
      baseBranch: "main",
      title: null,
    });
    const result = creating.then(
      () => null,
      (error: unknown) => error,
    );
    startWinner.resolve();
    try {
      await winner;
      const saved = (await workspaceRegistry.get("a"))!;
      expect(String(await result)).toContain("backend or incarnation changed");
      expect(await workspaceRegistry.get("misbound")).toBeNull();
      expect(await workspaceRegistry.get("a")).toEqual(saved);
    } finally {
      await Promise.allSettled([winner, creating]);
      h.fixture.dispose();
    }
  },
);

test.skipIf(!isJjAvailable())(
  "directory creation cannot replace an existing archived recovery record with the same id",
  async () => {
    const h = await jjOpenRaceFixture(false);
    try {
      await archiveByScope(h.archiveDeps, {
        scope: { kind: "workspace", workspaceId: "b" },
        requestId: "winner",
      });
      await h.createReplacement();
      const saved = (await workspaceRegistry.get("a"))!;
      await expect(
        h.provisioning.createWorkspaceForDirectory(h.a.cwd, null, h.a.projectId, {
          workspaceId: "a",
        }),
      ).rejects.toThrow("Record already exists: a");
      expect(await workspaceRegistry.get("a")).toEqual(saved);
      expect(saved.recoveryBookmark).toMatch(/^paseo\/recovery\//);
    } finally {
      h.fixture.dispose();
    }
  },
);

test.skipIf(!isJjAvailable())(
  "active jj directory refresh holds ownership and updates only observed fields",
  async () => {
    const h = await jjOpenRaceFixture(true);
    const reached = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    await workspaceRegistry.update("a", (record) => ({ ...record, archivedAt: null }));
    h.fixture.jj(["bookmark", "rename", "old-feature", "refreshed-feature"], h.old.worktreePath);
    updatePaseoWorktreeJjBookmark(h.old.worktreePath, {
      from: "old-feature",
      to: "refreshed-feature",
    });
    const readCheckout = h.git.getCheckout;
    let gate = true;
    h.git.getCheckout = async (cwd) => {
      const observed = await readCheckout(cwd);
      if (cwd === h.a.cwd && gate) {
        gate = false;
        reached.resolve();
        await finish.promise;
      }
      return observed;
    };
    const opening = h.provisioning.findOrCreateWorkspaceForDirectory(h.a.cwd);
    await reached.promise;
    let archiveEntered = false;
    const archiving = withWorkspaceLifecycle(h.old.worktreePath, async () => {
      archiveEntered = true;
      return archiveByScope(h.archiveDeps, {
        scope: { kind: "workspace", workspaceId: "b" },
        requestId: "refresh",
      });
    });
    try {
      await workspaceRegistry.update("a", (record) => ({ ...record, title: "Latest title" }));
      expect(archiveEntered).toBe(false);
      finish.resolve();
      const refreshed = await opening;
      expect(refreshed.title).toBe("Latest title");
      expect(refreshed.branch).toBe("refreshed-feature");
      expect(refreshed.archivedAt).toBeNull();
      expect((await archiving).removedDirectory).toBe(false);
      expect(readFileSync(path.join(h.old.worktreePath, "old-work.txt"), "utf8")).toBe(
        "saved old work\n",
      );
    } finally {
      finish.resolve();
      await Promise.allSettled([opening, archiving]);
      h.fixture.dispose();
    }
  },
);

test.skipIf(!isJjAvailable())(
  "directory unarchive refuses changed durable placement from a stale caller snapshot",
  async () => {
    const h = await jjOpenRaceFixture(true);
    const stale = (await workspaceRegistry.get("a"))!;
    const continueWinner = Promise.withResolvers<void>();
    const winner = withWorkspaceLifecycle(h.old.worktreePath, async () => {
      await continueWinner.promise;
      const fresh = await h.createReplacement();
      await workspaceRegistry.update("a", (record) => ({
        ...record,
        cwd: path.join(fresh.worktreePath, "sub"),
        worktreeRoot: fresh.worktreePath,
        jjWorkspaceId: readJjWorkspaceIncarnation(fresh.worktreePath)!,
      }));
    });
    const opening = h.provisioning.ensureWorkspaceRecordUnarchived(stale);
    const result = opening.then(
      () => null,
      (error: unknown) => error,
    );
    continueWinner.resolve();
    try {
      await winner;
      const saved = (await workspaceRegistry.get("a"))!;
      expect(String(await result)).toContain("placement or incarnation changed");
      expect(await workspaceRegistry.get("a")).toEqual(saved);
      expect(existsSync(path.join(h.old.worktreePath, "old-work.txt"))).toBe(true);
    } finally {
      await Promise.allSettled([winner, opening]);
      h.fixture.dispose();
    }
  },
);

test.skipIf(!isJjAvailable())(
  "directory unarchive requires matching live jj registration as well as incarnation",
  async () => {
    const h = await jjOpenRaceFixture(true);
    try {
      const saved = (await workspaceRegistry.get("a"))!;
      h.fixture.jj(["workspace", "forget", "reused"]);
      await expect(h.provisioning.findOrCreateWorkspaceForDirectory(h.a.cwd)).rejects.toThrow(
        "no longer registered",
      );
      expect(await workspaceRegistry.get("a")).toEqual(saved);
      expect(readFileSync(path.join(h.old.worktreePath, "old-work.txt"), "utf8")).toBe(
        "saved old work\n",
      );
    } finally {
      h.fixture.dispose();
    }
  },
);

test.skipIf(!isJjAvailable())(
  "legacy exact-subproject recovery uses the shared backing root for provisioning reentry",
  async () => {
    const h = await jjOpenRaceFixture(true);
    try {
      expect(
        (
          await archiveByScope(h.archiveDeps, {
            scope: { kind: "workspace", workspaceId: "b" },
            requestId: "legacy",
          })
        ).removedDirectory,
      ).toBe(true);
      for (const id of ["a", "b"])
        await workspaceRegistry.update(id, (record) => ({
          ...record,
          worktreeRoot: null,
          jjWorkspaceId: undefined,
        }));
      const recovery = createWorkspaceRecoveryService({
        paseoHome: tmpDir,
        worktreesRoot: path.join(tmpDir, "jj-worktrees"),
        getWorkspace: (id) => workspaceRegistry.get(id),
        getProject: (id) => projectRegistry.get(id),
        isDirectory,
        unarchiveWorkspace: async (record) => {
          await h.provisioning.ensureWorkspaceRecordUnarchived(record);
        },
        clearRecoveryPin: (id, pin) => clearWorkspaceRecoveryReference(workspaceRegistry, id, pin),
      });
      await expect(recovery.restore("a")).resolves.toEqual({ workspaceId: "a", action: "restore" });
      await expect(recovery.restore("b")).resolves.toEqual({
        workspaceId: "b",
        action: "unarchive",
      });
      expect((await workspaceRegistry.get("a"))?.worktreeRoot).toBe(h.old.worktreePath);
      expect((await workspaceRegistry.get("a"))?.jjWorkspaceId).toBe(
        readJjWorkspaceIncarnation(h.old.worktreePath),
      );
      expect(readFileSync(path.join(h.old.worktreePath, "old-work.txt"), "utf8")).toBe(
        "saved old work\n",
      );
    } finally {
      h.fixture.dispose();
    }
  },
);

test.skipIf(!isJjAvailable())(
  "active jj refresh refuses a contradictory checkout observation without demoting authority",
  async () => {
    const h = await jjOpenRaceFixture(false);
    try {
      await workspaceRegistry.update("a", (record) => ({ ...record, archivedAt: null }));
      const saved = (await workspaceRegistry.get("a"))!;
      const readCheckout = h.git.getCheckout;
      h.git.getCheckout = async (cwd) =>
        cwd === h.a.cwd
          ? {
              cwd,
              isGit: false,
              currentBranch: null,
              remoteUrl: null,
              worktreeRoot: null,
              mainRepoRoot: null,
              isPaseoOwnedWorktree: false,
            }
          : readCheckout(cwd);
      await expect(h.provisioning.findOrCreateWorkspaceForDirectory(h.a.cwd)).rejects.toThrow(
        "ownership changed",
      );
      expect(await workspaceRegistry.get("a")).toEqual(saved);
      expect(readFileSync(path.join(h.old.worktreePath, "old-work.txt"), "utf8")).toBe(
        "saved old work\n",
      );
    } finally {
      h.fixture.dispose();
    }
  },
);
