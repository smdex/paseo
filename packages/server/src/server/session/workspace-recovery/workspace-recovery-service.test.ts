import {
  readJjWorkspaceIncarnation,
  writeJjWorkspaceIncarnation,
} from "../../../utils/worktree-metadata.js";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, test } from "vitest";

import pino from "pino";
import { archivePersistedWorkspaceRecord } from "../../workspace-archive-service.js";
import { getCheckoutStatus } from "../../../utils/checkout-git.js";
import {
  readPaseoWorktreeMetadata,
  writePaseoWorktreeMetadata,
} from "../../../utils/worktree-metadata.js";
import { createWorktree, deletePaseoWorktree } from "../../../utils/worktree.js";
import {
  clearWorkspaceRecoveryReference,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";
import { createWorkspaceRecoveryService } from "./workspace-recovery-service.js";
import {
  createJjWorktree,
  deleteJjPaseoWorktree,
  listJjWorkspaces,
} from "../../../utils/worktree-jj.js";
import { createScratchJjRepo, isJjAvailable } from "../../../test-utils/jj.js";

const describeIfJj = describe.skipIf(!isJjAvailable());

const NOW = "2026-07-11T10:12:30.752Z";
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createProject(overrides: Partial<PersistedProjectRecord> = {}): PersistedProjectRecord {
  return createPersistedProjectRecord({
    projectId: "/project",
    rootPath: "/project",
    kind: "git",
    displayName: "project",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function createWorkspace(
  overrides: Partial<PersistedWorkspaceRecord> = {},
): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: "wks_15a1b5630ebaab33",
    projectId: "/project",
    cwd: "/worktrees/trigger-1525443412986298439",
    kind: "worktree",
    displayName: "diagnose-repro-tdd",
    title: "TDD reproduction",
    branch: "diagnose-repro-tdd",
    worktreeRoot: "/worktrees/trigger-1525443412986298439",
    isPaseoOwnedWorktree: true,
    mainRepoRoot: "/repo",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: NOW,
    ...overrides,
  });
}

function createHarness(input?: {
  workspace?: PersistedWorkspaceRecord | null;
  project?: PersistedProjectRecord | null;
  directories?: string[];
  paseoHome?: string;
  worktreesRoot?: string;
}) {
  const workspace = input?.workspace === undefined ? createWorkspace() : input.workspace;
  const project = input?.project === undefined ? createProject() : input.project;
  const directories = new Set(input?.directories ?? ["/repo"]);
  const unarchived: string[] = [];
  const service = createWorkspaceRecoveryService({
    paseoHome: input?.paseoHome ?? "/paseo-home",
    worktreesRoot: input?.worktreesRoot ?? "/worktrees",
    getWorkspace: async (workspaceId) =>
      workspace?.workspaceId === workspaceId ? workspace : null,
    getProject: async (projectId) => (project?.projectId === projectId ? project : null),
    isDirectory: async (path) => directories.has(path),
    unarchiveWorkspace: async (record) => {
      unarchived.push(record.workspaceId);
    },
  });
  return { service, unarchived };
}

describe("workspace recovery", () => {
  test("describes a missing archived worktree from persisted placement", async () => {
    const { service, unarchived } = createHarness();

    await expect(service.inspect("wks_15a1b5630ebaab33")).resolves.toEqual({
      kind: "recoverable",
      workspaceId: "wks_15a1b5630ebaab33",
      workspaceName: "TDD reproduction",
      action: "restore",
      branch: "diagnose-repro-tdd",
    });
    expect(unarchived).toEqual([]);
  });

  test("unarchives an archived workspace whose exact directory remains", async () => {
    const workspace = createWorkspace({ kind: "directory", branch: null });
    const { service, unarchived } = createHarness({
      workspace,
      directories: [workspace.cwd],
    });

    await expect(service.restore(workspace.workspaceId)).resolves.toEqual({
      workspaceId: workspace.workspaceId,
      action: "unarchive",
    });
    expect(unarchived).toEqual([workspace.workspaceId]);
  });

  test("does not offer recovery for a missing non-worktree directory", async () => {
    const workspace = createWorkspace({ kind: "directory", branch: null });
    const { service } = createHarness({ workspace });

    await expect(service.inspect(workspace.workspaceId)).resolves.toEqual({
      kind: "unavailable",
      workspaceId: workspace.workspaceId,
      reason: "workspace_directory_missing",
      message: "The archived workspace directory no longer exists and cannot be recreated.",
    });
  });

  test("uses the persisted source repository instead of the owning project to restore an exact subdirectory", async () => {
    const { tempDir, repoDir } = createGitRepository();
    const branch = "feature/mixed-project";
    const sourceSubdirectory = join(repoDir, "packages", "app");
    mkdirSync(sourceSubdirectory, { recursive: true });
    writeFileSync(join(sourceSubdirectory, "README.md"), "app\n");
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "add app"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["branch", branch], { cwd: repoDir, stdio: "pipe" });

    const paseoHome = join(tempDir, "paseo-home");
    const worktreesRoot = join(tempDir, "worktrees");
    const created = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "mixed-project",
      source: { kind: "checkout-branch", branchName: branch },

      paseoHome,
      worktreesRoot,
    });
    const worktreeRoot = realpathSync(created.worktreePath);
    const workspaceCwd = join(worktreeRoot, "packages", "app");
    rmSync(worktreeRoot, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });

    const projectRoot = join(tempDir, "explicit-non-git-project");
    mkdirSync(projectRoot);
    const project = createProject({
      projectId: "explicit-non-git-project",
      rootPath: projectRoot,
      kind: "non_git",
    });
    const workspace = createWorkspace({
      workspaceId: "ws-mixed-project-recreate",
      projectId: project.projectId,
      cwd: workspaceCwd,
      branch,
      worktreeRoot,
      mainRepoRoot: repoDir,
    });
    const unarchived: string[] = [];
    const service = createWorkspaceRecoveryService({
      paseoHome,
      worktreesRoot,
      getWorkspace: async (workspaceId) =>
        workspaceId === workspace.workspaceId ? workspace : null,
      getProject: async (projectId) => (projectId === project.projectId ? project : null),
      isDirectory: async (path) => existsSync(path) && statSync(path).isDirectory(),
      unarchiveWorkspace: async (record) => {
        unarchived.push(record.workspaceId);
      },
    });

    await expect(service.restore(workspace.workspaceId)).resolves.toEqual({
      workspaceId: workspace.workspaceId,
      action: "restore",
    });
    expect(existsSync(worktreeRoot)).toBe(true);
    expect(existsSync(workspaceCwd)).toBe(true);
    expect(unarchived).toEqual([workspace.workspaceId]);
  });

  test("keeps an exact-subdirectory workspace archived when its branch lacks that directory", async () => {
    const { tempDir, repoDir } = createGitRepository();
    const branch = "feature/without-subproject";
    execFileSync("git", ["branch", branch], { cwd: repoDir, stdio: "pipe" });
    const paseoHome = join(tempDir, "paseo-home");
    const worktreesRoot = join(tempDir, "worktrees");
    const created = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "without-subproject",
      source: { kind: "checkout-branch", branchName: branch },

      paseoHome,
      worktreesRoot,
    });
    const worktreeRoot = realpathSync(created.worktreePath);
    const workspaceCwd = join(worktreeRoot, "packages", "app");
    rmSync(worktreeRoot, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });

    const project = createProject({ rootPath: repoDir });
    const workspace = createWorkspace({
      workspaceId: "ws-missing-restored-subdirectory",
      cwd: workspaceCwd,
      branch,
      worktreeRoot,
      mainRepoRoot: repoDir,
    });
    const unarchived: string[] = [];
    const service = createWorkspaceRecoveryService({
      paseoHome,
      worktreesRoot,
      getWorkspace: async (workspaceId) =>
        workspaceId === workspace.workspaceId ? workspace : null,
      getProject: async (projectId) => (projectId === project.projectId ? project : null),
      isDirectory: async (targetPath) =>
        existsSync(targetPath) && statSync(targetPath).isDirectory(),
      unarchiveWorkspace: async (record) => {
        unarchived.push(record.workspaceId);
      },
    });

    await expect(service.restore(workspace.workspaceId)).rejects.toThrow(
      "Selected project directory is missing from the restored worktree",
    );
    expect(unarchived).toEqual([]);
    expect(existsSync(worktreeRoot)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoDir,
        stdio: "pipe",
      })
        .toString()
        .includes("without-subproject"),
    ).toBe(false);
  });

  test("keeps the workspace archived when its persisted source repository is missing", async () => {
    const workspace = createWorkspace({ mainRepoRoot: "/missing-source" });
    const { service, unarchived } = createHarness({
      workspace,
      directories: ["/project"],
    });

    await expect(service.inspect(workspace.workspaceId)).resolves.toEqual({
      kind: "unavailable",
      workspaceId: workspace.workspaceId,
      reason: "project_directory_missing",
      message: "The source repository needed to restore this worktree no longer exists.",
    });
    await expect(service.restore(workspace.workspaceId)).rejects.toThrow(
      "The source repository needed to restore this worktree no longer exists.",
    );
    expect(unarchived).toEqual([]);
  });
});

function createGitRepository(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "paseo-workspace-recovery-"));
  tempDirectories.push(tempDir);
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  writeFileSync(join(repoDir, "README.md"), "initial\n");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

async function createBaseRecoveryFixture(baseBranch: string | null) {
  const { tempDir, repoDir } = createGitRepository();
  const paseoHome = join(tempDir, "paseo-home");
  const created = await createWorktree({
    cwd: repoDir,
    paseoHome,
    worktreeSlug: "base-recovery",
    source: { kind: "branch-off", branchName: "feature", baseBranch: "main" },
  });
  writeFileSync(join(created.worktreePath, "feature.txt"), "feature\n");
  execFileSync("git", ["add", "."], { cwd: created.worktreePath });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature"], {
    cwd: created.worktreePath,
    stdio: "pipe",
  });
  const workspace = createWorkspace({
    workspaceId: "base-recovery",
    cwd: created.worktreePath,
    worktreeRoot: created.worktreePath,
    mainRepoRoot: repoDir,
    branch: "feature",
    baseBranch,
    archivedAt: null,
  });
  const project = createProject({ rootPath: repoDir });
  const registry = new FileBackedWorkspaceRegistry(
    join(tempDir, "workspaces.json"),
    pino({ level: "silent" }),
  );
  await registry.upsert(workspace);
  const service = createWorkspaceRecoveryService({
    paseoHome,
    getWorkspace: (id) => registry.get(id),
    getProject: async () => project,
    isDirectory: async (target) => existsSync(target) && statSync(target).isDirectory(),
    unarchiveWorkspace: async (record) => {
      await registry.update(record.workspaceId, (value) => ({ ...value, archivedAt: null }));
    },
  });
  async function archiveAndRemove() {
    await archivePersistedWorkspaceRecord({
      workspaceId: workspace.workspaceId,
      workspaceRegistry: registry,
    });
    await deletePaseoWorktree({ cwd: repoDir, worktreePath: workspace.cwd, paseoHome });
    expect(existsSync(workspace.cwd)).toBe(false);
  }
  return { workspace, registry, service, paseoHome, repoDir, tempDir, archiveAndRemove };
}

test("preserves ordinary checkout behavior when no separate base was recorded", async () => {
  const fixture = await createBaseRecoveryFixture(null);
  await writePaseoWorktreeMetadata(fixture.workspace.cwd, { baseRefName: "feature" });
  await fixture.archiveAndRemove();
  await fixture.service.restore(fixture.workspace.workspaceId);
  expect((await fixture.registry.get(fixture.workspace.workspaceId))?.baseBranch).toBeNull();
  expect(
    await getCheckoutStatus(fixture.workspace.cwd, { paseoHome: fixture.paseoHome }),
  ).toMatchObject({ currentBranch: "feature", baseRef: "feature" });
});

test("restores a branchless workspace from its recorded base so work can continue", async () => {
  const fixture = await createBaseRecoveryFixture("refs/heads/release");
  execFileSync("git", ["switch", "-c", "release"], { cwd: fixture.repoDir, stdio: "pipe" });
  writeFileSync(join(fixture.repoDir, "release.txt"), "release\n");
  execFileSync("git", ["add", "release.txt"], { cwd: fixture.repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "release"], { cwd: fixture.repoDir, stdio: "pipe" });
  execFileSync("git", ["switch", "main"], { cwd: fixture.repoDir, stdio: "pipe" });
  await fixture.registry.update(fixture.workspace.workspaceId, (workspace) => ({
    ...workspace,
    branch: null,
  }));
  await fixture.archiveAndRemove();

  await expect(fixture.service.inspect(fixture.workspace.workspaceId)).resolves.toMatchObject({
    kind: "recoverable",
    action: "restore",
    branch: null,
  });
  await expect(fixture.service.restore(fixture.workspace.workspaceId)).resolves.toEqual({
    workspaceId: fixture.workspace.workspaceId,
    action: "restore",
  });

  const checkout = await getCheckoutStatus(fixture.workspace.cwd, { paseoHome: fixture.paseoHome });
  expect(checkout.currentBranch).toBeTruthy();
  expect(checkout.currentBranch).not.toBe("feature");
  expect(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.workspace.cwd,
      encoding: "utf8",
    }).trim(),
  ).toBe(
    execFileSync("git", ["rev-parse", "release"], {
      cwd: fixture.repoDir,
      encoding: "utf8",
    }).trim(),
  );
});

test("restores a branchless workspace from the repository default when its base is missing", async () => {
  const fixture = await createBaseRecoveryFixture("refs/heads/deleted-base");
  await fixture.registry.update(fixture.workspace.workspaceId, (workspace) => ({
    ...workspace,
    branch: null,
  }));
  await fixture.archiveAndRemove();

  await expect(fixture.service.restore(fixture.workspace.workspaceId)).resolves.toEqual({
    workspaceId: fixture.workspace.workspaceId,
    action: "restore",
  });
  expect(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.workspace.cwd,
      encoding: "utf8",
    }).trim(),
  ).toBe(
    execFileSync("git", ["rev-parse", "main"], { cwd: fixture.repoDir, encoding: "utf8" }).trim(),
  );
});

test("restores the branch HEAD with a base name when the exact base is missing", async () => {
  const fixture = await createBaseRecoveryFixture("refs/remotes/upstream/main");
  const headBeforeArchive = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.workspace.cwd,
    encoding: "utf8",
  }).trim();
  await fixture.archiveAndRemove();
  await expect(fixture.service.restore(fixture.workspace.workspaceId)).resolves.toEqual({
    workspaceId: fixture.workspace.workspaceId,
    action: "restore",
  });
  expect(existsSync(fixture.workspace.cwd)).toBe(true);
  expect((await fixture.registry.get(fixture.workspace.workspaceId))?.archivedAt).toBeNull();
  const metadata = await readPaseoWorktreeMetadata(fixture.workspace.cwd);
  expect(metadata).toMatchObject({ baseRefName: "main" });
  expect(metadata?.baseRef).toBeUndefined();
  expect(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.workspace.cwd,
      encoding: "utf8",
    }).trim(),
  ).toBe(headBeforeArchive);
});

test("restore fetches a deleted local branch from origin and retains its base", async () => {
  const fixture = await createBaseRecoveryFixture("refs/heads/main");
  const remote = join(fixture.tempDir, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: fixture.repoDir });
  execFileSync("git", ["push", "origin", "feature"], { cwd: fixture.repoDir, stdio: "pipe" });
  await fixture.archiveAndRemove();
  execFileSync("git", ["branch", "-D", "feature"], { cwd: fixture.repoDir });
  await fixture.service.restore(fixture.workspace.workspaceId);
  expect((await readPaseoWorktreeMetadata(fixture.workspace.cwd))?.baseRef).toBe("refs/heads/main");
  expect(
    await getCheckoutStatus(fixture.workspace.cwd, { paseoHome: fixture.paseoHome }),
  ).toMatchObject({
    currentBranch: "feature",
    baseRef: "main",
    aheadBehind: { ahead: 1, behind: 0 },
  });
});

test("restore rejects a branch checked out elsewhere without inventing another branch", async () => {
  const fixture = await createBaseRecoveryFixture("refs/heads/main");
  await fixture.archiveAndRemove();
  execFileSync("git", ["switch", "feature"], { cwd: fixture.repoDir, stdio: "pipe" });
  await expect(fixture.service.restore(fixture.workspace.workspaceId)).rejects.toThrow(
    /already checked out/,
  );
  expect(existsSync(fixture.workspace.cwd)).toBe(false);
  expect((await fixture.registry.get(fixture.workspace.workspaceId))?.archivedAt).not.toBeNull();
  expect(
    execFileSync("git", ["branch", "--list", "feature*"], {
      cwd: fixture.repoDir,
      encoding: "utf8",
    }).trim(),
  ).toBe("* feature");
});

test("restores a user-created worktree at its recorded path outside Paseo's root", async () => {
  const { tempDir, repoDir } = createGitRepository();
  const worktreeRoot = join(realpathSync(tempDir), "external-worktree");
  execFileSync("git", ["worktree", "add", "-b", "external-feature", worktreeRoot], {
    cwd: repoDir,
    stdio: "pipe",
  });
  const workspace = createWorkspace({
    cwd: worktreeRoot,
    worktreeRoot,
    mainRepoRoot: repoDir,
    branch: "external-feature",
    baseBranch: "main",
    isPaseoOwnedWorktree: false,
  });
  execFileSync("git", ["worktree", "remove", worktreeRoot], { cwd: repoDir, stdio: "pipe" });
  const unarchived: string[] = [];
  const service = createWorkspaceRecoveryService({
    paseoHome: join(tempDir, "paseo-home"),
    getWorkspace: async () => workspace,
    getProject: async () => createProject({ rootPath: repoDir }),
    isDirectory: async (target) => existsSync(target) && statSync(target).isDirectory(),
    unarchiveWorkspace: async (record) => {
      unarchived.push(record.workspaceId);
    },
  });
  await expect(service.restore(workspace.workspaceId)).resolves.toEqual({
    workspaceId: workspace.workspaceId,
    action: "restore",
  });
  expect(readFileSync(join(worktreeRoot, "README.md"), "utf8").trim()).toBe("initial");
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: worktreeRoot,
      encoding: "utf8",
    }).trim(),
  ).toBe("external-feature");
  expect(unarchived).toEqual([workspace.workspaceId]);
});

describeIfJj("workspace recovery on jj", () => {
  function jjHarness(input: {
    records: PersistedWorkspaceRecord[];
    project: PersistedProjectRecord;
  }) {
    const records = new Map(input.records.map((record) => [record.workspaceId, { ...record }]));
    const cleared: string[] = [];
    const deps: Parameters<typeof createWorkspaceRecoveryService>[0] = {
      paseoHome: "/paseo-home",
      getWorkspace: async (workspaceId) => records.get(workspaceId) ?? null,
      getProject: async (projectId) =>
        input.project.projectId === projectId ? input.project : null,
      isDirectory: async (path) => existsSync(path),
      unarchiveWorkspace: async (record) => {
        const current = records.get(record.workspaceId);
        if (current) {
          records.set(record.workspaceId, { ...current, archivedAt: null });
        }
      },
      clearRecoveryPin: (workspaceId, expectedPin) =>
        clearWorkspaceRecoveryReference(
          {
            update: async (id, updater) => {
              const current = records.get(id);
              if (!current) return null;
              const next = updater(current);
              records.set(id, next);
              if (next.recoveryBookmark !== current.recoveryBookmark) cleared.push(id);
              return next;
            },
          },
          workspaceId,
          expectedPin,
        ),
    };
    const service = createWorkspaceRecoveryService(deps);
    return { service, records, cleared, deps };
  }

  function jjProjectFixture() {
    const fixture = createScratchJjRepo({ colocate: true, files: { "readme.md": "hello\n" } });
    tempDirectories.push(fixture.dir);
    const base = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim();
    fixture.jj(["bookmark", "create", "main", "-r", base]);
    const worktreesRoot = join(fixture.dir, "worktrees-home");
    mkdirSync(worktreesRoot, { recursive: true });
    const project = createProject({
      projectId: "p1",
      rootPath: fixture.repoDir,
      kind: "git",
    });
    return { fixture, base, worktreesRoot, project };
  }

  it("recognizes a registered backing root for a surviving subproject record", async () => {
    const { fixture, worktreesRoot, project } = jjProjectFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "root-name",
      worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature-root" },
    });
    const cwd = join(created.worktreePath, "different-subproject-name");
    mkdirSync(cwd);
    fixture.jj(["bookmark", "create", "paseo/recovery/subproject", "-r", "repo-root-name@"]);
    const record = createWorkspace({
      workspaceId: "wks_subproject",
      jjWorkspaceId: (await readJjWorkspaceIncarnation(created.worktreePath))!,
      projectId: project.projectId,
      cwd,
      worktreeRoot: created.worktreePath,
      mainRepoRoot: fixture.repoDir,
      recoveryBookmark: "paseo/recovery/subproject",
    });
    const { service } = jjHarness({ records: [record], project });
    await expect(service.inspect("wks_subproject")).resolves.toMatchObject({
      kind: "recoverable",
      action: "unarchive",
    });
  });

  it("classifies a surviving unregistered directory as restore, by worktree root", async () => {
    const { fixture, worktreesRoot, project } = jjProjectFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "survivor",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/survivor" },
      worktreesRoot,
    });
    fixture.jj(["describe", "-m", "surviving work"], created.worktreePath);
    let recoveryBookmark = "";
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      worktreesRoot,
      persistRecoveryPin: async (pin) => {
        recoveryBookmark = pin;
      },
    });
    // Simulate the crash window: forget+quarantine happened, but a partial
    // failure left a directory behind at the original path.
    mkdirSync(created.worktreePath, { recursive: true });
    writeFileSync(join(created.worktreePath, "partial.txt"), "survived\n");

    const record = createWorkspace({
      workspaceId: "wks_survivor",
      projectId: project.projectId,
      cwd: created.worktreePath,
      worktreeRoot: created.worktreePath,
      mainRepoRoot: fixture.repoDir,
      branch: "feat/survivor",
      recoveryBookmark,
    });
    const { service } = jjHarness({ records: [record], project });

    await expect(service.inspect("wks_survivor")).resolves.toMatchObject({
      kind: "recoverable",
      action: "restore",
    });
  });

  it("restores by moving a surviving directory aside and recreating at the pin", async () => {
    const { fixture, worktreesRoot, project } = jjProjectFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "restorable",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/restorable" },
      worktreesRoot,
    });
    fixture.jj(["describe", "-m", "pinned work"], created.worktreePath);
    let recoveryBookmark = "";
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      worktreesRoot,
      persistRecoveryPin: async (pin) => {
        recoveryBookmark = pin;
      },
    });
    // Surviving directory from a partial deletion (nonempty → blocks add).
    mkdirSync(created.worktreePath, { recursive: true });
    writeFileSync(join(created.worktreePath, "orphaned.txt"), "kept\n");

    const record = createWorkspace({
      workspaceId: "wks_restorable",
      projectId: project.projectId,
      cwd: created.worktreePath,
      worktreeRoot: created.worktreePath,
      mainRepoRoot: fixture.repoDir,
      branch: "feat/restorable",
      recoveryBookmark,
    });
    const { service } = jjHarness({ records: [record], project });

    await expect(service.restore("wks_restorable")).resolves.toEqual({
      workspaceId: "wks_restorable",
      action: "restore",
    });
    // The workspace is back at the pin's change...
    const description = fixture
      .jj(["log", "--no-graph", "-r", "repo-restorable@-", "-T", "description"])
      .stdout.trim();
    expect(description).toBe("pinned work");
    // ...and the surviving directory was preserved as an orphan sibling.
    const orphanParent = join(created.worktreePath, "..");
    const orphans = readdirSync(orphanParent).filter((name) =>
      name.startsWith("repo-restorable.orphan-"),
    );
    expect(orphans.length).toBe(1);
    expect(existsSync(join(orphanParent, orphans[0] ?? "", "orphaned.txt"))).toBe(true);
    expect(existsSync(join(created.worktreePath, "orphaned.txt"))).toBe(false);
  });

  it("keeps a shared recovery pin while a sibling record still references it", async () => {
    const { fixture, worktreesRoot, project } = jjProjectFixture();
    const pinShared = "paseo/recovery/shared";
    const createdA = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "shared-a",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/shared-a" },
      worktreesRoot,
    });
    fixture.jj(["bookmark", "create", pinShared, "-r", "repo-shared-a@"]);
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: createdA.worktreePath,
      worktreesRoot,
    });

    // Two archived records shared the backing checkout and thus the pin (the
    // archive flow persists it for every sibling record).
    const recordA = createWorkspace({
      workspaceId: "wks_a",
      projectId: project.projectId,
      cwd: createdA.worktreePath,
      worktreeRoot: createdA.worktreePath,
      mainRepoRoot: fixture.repoDir,
      branch: "feat/shared-a",
      recoveryBookmark: pinShared,
    });
    const recordB = createWorkspace({
      workspaceId: "wks_b",
      projectId: project.projectId,
      cwd: createdA.worktreePath,
      worktreeRoot: createdA.worktreePath,
      mainRepoRoot: fixture.repoDir,
      branch: "feat/shared-a",
      recoveryBookmark: pinShared,
    });
    const { service, records } = jjHarness({ records: [recordA, recordB], project });
    const { jjRevisionResolves } = await import("../../../utils/worktree-jj.js");

    // Restoring ONE record must not consume the pin the sibling still needs.
    await service.restore("wks_a");
    expect(await jjRevisionResolves(fixture.repoDir, pinShared)).toBe(true);
    // The backing root now exists, so the last sibling plain-unarchives.
    await expect(service.restore("wks_b")).resolves.toEqual({
      workspaceId: "wks_b",
      action: "unarchive",
    });
    expect(await jjRevisionResolves(fixture.repoDir, pinShared)).toBe(true);
    expect(records.get("wks_b")?.recoveryBookmark).toBeNull();
  });

  it("refuses an invalid recovery reference even when plain-unarchiving a surviving root", async () => {
    const { fixture, project } = jjProjectFixture();
    const record = createWorkspace({
      workspaceId: "wks_invalid_pin",
      projectId: project.projectId,
      cwd: fixture.repoDir,
      worktreeRoot: fixture.repoDir,
      mainRepoRoot: fixture.repoDir,
      recoveryBookmark: "main",
    });
    const { service, cleared, records } = jjHarness({ records: [record], project });
    await expect(service.restore("wks_invalid_pin")).rejects.toThrow("not a Paseo recovery pin");
    expect(cleared).toEqual([]);
    expect(records.get("wks_invalid_pin")?.archivedAt).toBe(record.archivedAt);
    const { jjRevisionResolves } = await import("../../../utils/worktree-jj.js");
    expect(await jjRevisionResolves(fixture.repoDir, "main")).toBe(true);
  });

  it("clears the last registry reference but retains its recovery pin", async () => {
    const { fixture, worktreesRoot, project } = jjProjectFixture();
    const createdA = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "last-ref",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/last-ref" },
      worktreesRoot,
    });
    fixture.jj(["describe", "-m", "last ref work"], createdA.worktreePath);
    let recoveryBookmark = "";
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: createdA.worktreePath,
      worktreesRoot,
      persistRecoveryPin: async (pin) => {
        recoveryBookmark = pin;
      },
    });

    const record = createWorkspace({
      workspaceId: "wks_last",
      projectId: project.projectId,
      cwd: createdA.worktreePath,
      worktreeRoot: createdA.worktreePath,
      mainRepoRoot: fixture.repoDir,
      branch: "feat/last-ref",
      recoveryBookmark,
    });
    const { service } = jjHarness({ records: [record], project });
    const { jjRevisionResolves } = await import("../../../utils/worktree-jj.js");

    await service.restore("wks_last");
    expect(await jjRevisionResolves(fixture.repoDir, record.recoveryBookmark ?? "")).toBe(true);
  });
  it("serializes sibling restores across service instances before resolving a stale plan", async () => {
    const { fixture, worktreesRoot, project } = jjProjectFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "concurrent",
      worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "concurrent-feature" },
    });
    mkdirSync(join(created.worktreePath, "subproject"));
    writeFileSync(join(created.worktreePath, "subproject", "base.txt"), "base\n");
    let pin = "";
    await deleteJjPaseoWorktree({
      cwd: fixture.repoDir,
      worktreePath: created.worktreePath,
      worktreesRoot,
      persistRecoveryPin: async (value) => {
        pin = value;
      },
    });
    const common = {
      projectId: project.projectId,
      worktreeRoot: created.worktreePath,
      mainRepoRoot: fixture.repoDir,
      recoveryBookmark: pin,
      branch: "concurrent-feature",
      baseBranch: "main",
    };
    const harness = jjHarness({
      project,
      records: [
        createWorkspace({ ...common, workspaceId: "restore-a", cwd: created.worktreePath }),
        createWorkspace({
          ...common,
          workspaceId: "restore-b",
          cwd: join(created.worktreePath, "subproject"),
        }),
      ],
    });
    const atSourceCheck = Promise.withResolvers<void>();
    const continueFirst = Promise.withResolvers<void>();
    const secondPlacementRead = Promise.withResolvers<void>();
    const secondDirectoryChecks: string[] = [];
    const orphans: string[] = [];
    const first = createWorkspaceRecoveryService({
      ...harness.deps,
      isDirectory: async (path) => {
        if (path === fixture.repoDir) {
          atSourceCheck.resolve();
          await continueFirst.promise;
        }
        return existsSync(path);
      },
      unarchiveWorkspace: async (record) => {
        await harness.deps.unarchiveWorkspace(record);
        writeFileSync(join(created.worktreePath, "live-after-first.txt"), "keep live\n");
      },
      reportOrphan: (path) => orphans.push(path),
    });
    const second = createWorkspaceRecoveryService({
      ...harness.deps,
      getWorkspace: async (id) => {
        secondPlacementRead.resolve();
        return harness.deps.getWorkspace(id);
      },
      isDirectory: async (path) => {
        secondDirectoryChecks.push(path);
        return existsSync(path);
      },
      reportOrphan: (path) => orphans.push(path),
    });
    const restoringFirst = first.restore("restore-a");
    await atSourceCheck.promise;
    const restoringSecond = second.restore("restore-b");
    await secondPlacementRead.promise;
    expect(secondDirectoryChecks).toEqual([]);
    continueFirst.resolve();
    await expect(restoringFirst).resolves.toEqual({ workspaceId: "restore-a", action: "restore" });
    await expect(restoringSecond).resolves.toEqual({
      workspaceId: "restore-b",
      action: "unarchive",
    });
    expect(orphans).toEqual([]);
    expect(readFileSync(join(created.worktreePath, "live-after-first.txt"), "utf8")).toBe(
      "keep live\n",
    );
    expect((await listJjWorkspaces(fixture.repoDir)).map((entry) => entry.name).sort()).toEqual([
      "default",
      "repo-concurrent",
    ]);
    expect(harness.records.get("restore-a")?.archivedAt).toBeNull();
    expect(harness.records.get("restore-b")?.archivedAt).toBeNull();
    expect(harness.records.get("restore-a")?.jjWorkspaceId).toBe(pin);
    expect(harness.records.get("restore-b")?.jjWorkspaceId).toBe(pin);
  });
  it("refuses legacy unarchive when a surviving registered root has no incarnation proof", async () => {
    const { fixture, project } = jjProjectFixture();
    const pin = "paseo/recovery/unknown-incarnation";
    fixture.jj(["bookmark", "create", pin, "--revision", "main"]);
    const record = createWorkspace({
      workspaceId: "legacy-unknown",
      projectId: project.projectId,
      cwd: fixture.repoDir,
      worktreeRoot: fixture.repoDir,
      mainRepoRoot: fixture.repoDir,
      recoveryBookmark: pin,
    });
    const h = jjHarness({ project, records: [record] });
    await expect(h.service.inspect(record.workspaceId)).resolves.toMatchObject({
      kind: "unavailable",
    });
    await expect(h.service.restore(record.workspaceId)).rejects.toThrow(
      "unknown or different incarnation",
    );
    expect(h.records.get(record.workspaceId)).toEqual(record);
    expect(h.cleared).toEqual([]);
    const { jjRevisionResolves } = await import("../../../utils/worktree-jj.js");
    expect(await jjRevisionResolves(fixture.repoDir, pin)).toBe(true);
    expect(readFileSync(join(fixture.repoDir, "readme.md"), "utf8")).toBe("hello\n");
  });
  it("reports retained reference cleanup failure without rejecting an already successful unarchive", async () => {
    const { fixture, project } = jjProjectFixture();
    const pin = "paseo/recovery/retained-cleanup";
    await writeJjWorkspaceIncarnation(fixture.repoDir, "retained-cleanup");
    fixture.jj(["bookmark", "create", pin, "--revision", "main"]);
    const record = createWorkspace({
      workspaceId: "retained-cleanup",
      jjWorkspaceId: "retained-cleanup",
      projectId: project.projectId,
      cwd: fixture.repoDir,
      worktreeRoot: fixture.repoDir,
      mainRepoRoot: fixture.repoDir,
      recoveryBookmark: pin,
    });
    const h = jjHarness({ project, records: [record] });
    const failure = new Error("reference write failed");
    const warnings: Array<{ pin: string; error: unknown }> = [];
    const service = createWorkspaceRecoveryService({
      ...h.deps,
      clearRecoveryPin: async () => {
        throw failure;
      },
      reportRetainedPin: (retainedPin, error) => warnings.push({ pin: retainedPin, error }),
    });
    await expect(service.restore("retained-cleanup")).resolves.toEqual({
      workspaceId: "retained-cleanup",
      action: "unarchive",
    });
    expect(h.records.get("retained-cleanup")?.archivedAt).toBeNull();
    expect(h.records.get("retained-cleanup")?.recoveryBookmark).toBe(pin);
    expect(warnings).toEqual([{ pin, error: failure }]);
    const { jjRevisionResolves } = await import("../../../utils/worktree-jj.js");
    expect(await jjRevisionResolves(fixture.repoDir, pin)).toBe(true);
  });
  test.each(["source-disappeared", "backing-disappeared", "external-contradiction"] as const)(
    "known jj recovery refuses %s without consuming pins or entering Git recreation",
    async (failure) => {
      const { fixture, worktreesRoot, project } = jjProjectFixture();
      const created = await createJjWorktree({
        cwd: fixture.repoDir,
        worktreeSlug: "protected",
        worktreesRoot,
        source: { kind: "branch-off", baseBranch: "main", branchName: "protected-feature" },
      });
      const pin = "paseo/recovery/protected";
      fixture.jj(["bookmark", "create", pin, "-r", "main"]);
      const record = createWorkspace({
        workspaceId: "protected",
        projectId: project.projectId,
        cwd: created.worktreePath,
        worktreeRoot: created.worktreePath,
        mainRepoRoot: fixture.repoDir,
        jjWorkspaceId: (await readJjWorkspaceIncarnation(created.worktreePath))!,
        jjWorkspaceManagement: "managed",
        recoveryBookmark: pin,
        kind: "directory",
        isPaseoOwnedWorktree: false,
      });
      if (failure === "source-disappeared")
        rmSync(join(fixture.repoDir, ".jj"), { recursive: true, force: true });
      if (failure === "backing-disappeared")
        rmSync(join(created.worktreePath, ".jj"), { recursive: true, force: true });
      if (failure === "external-contradiction") record.jjWorkspaceManagement = "external";
      const h = jjHarness({ project, records: [record] });
      await expect(h.service.inspect("protected")).resolves.toMatchObject({ kind: "unavailable" });
      await expect(h.service.restore("protected")).rejects.toThrow(
        /incarnation|source repository|contradicts/,
      );
      expect(h.records.get("protected")).toEqual(record);
      expect(h.cleared).toEqual([]);
      expect(readFileSync(join(created.worktreePath, "readme.md"), "utf8")).toBe("hello\n");
    },
  );
  async function missingSelectionFixture(subproject: boolean) {
    const { fixture, worktreesRoot, project } = jjProjectFixture();
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreesRoot,
      worktreeSlug: "original",
      source: { kind: "branch-off", baseBranch: "main", branchName: "original-feature" },
    });
    const root = created.worktreePath;
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "saved.txt"), "approved subproject bytes\n");
    fixture.jj(["describe", "-m", "old work"], root);
    const pin = "paseo/recovery/missing-selection";
    fixture.jj(["bookmark", "create", pin, "-r", "repo-original@"]);
    const record = createWorkspace({
      workspaceId: "missing-selection",
      projectId: project.projectId,
      cwd: subproject ? join(root, "sub") : root,
      worktreeRoot: root,
      mainRepoRoot: fixture.repoDir,
      jjWorkspaceManagement: "managed",
      jjWorkspaceId: (await readJjWorkspaceIncarnation(root))!,
      recoveryBookmark: pin,
    });
    return { fixture, root, record, harness: jjHarness({ records: [record], project }) };
  }

  test.each([
    [false, "git"],
    [true, "git"],
    [false, "jj"],
    [true, "jj"],
  ] as const)(
    "surviving replacement backing refuses recovery even with missing selected cwd (subproject=%s, backend=%s)",
    async (subproject, backend) => {
      const h = await missingSelectionFixture(subproject);
      h.fixture.jj(["workspace", "forget", "repo-original"]);
      renameSync(h.root, `${h.root}.original`);
      if (backend === "git") {
        mkdirSync(h.root);
        execFileSync("git", ["init", "-b", "main"], { cwd: h.root, stdio: "pipe" });
      } else {
        expect(
          h.fixture.jj([
            "workspace",
            "add",
            h.root,
            "--name",
            "replacement",
            "--revision",
            "root()",
          ]).status,
        ).toBe(0);
        await writeJjWorkspaceIncarnation(h.root, "replacement-incarnation");
      }
      writeFileSync(join(h.root, "user.txt"), "unrelated checkout bytes\n");
      const orphans: string[] = [];
      const recovery = createWorkspaceRecoveryService({
        ...h.harness.deps,
        reportOrphan: (path) => orphans.push(path),
      });
      await expect(recovery.inspect(h.record.workspaceId)).resolves.toMatchObject({
        kind: "unavailable",
      });
      await expect(recovery.restore(h.record.workspaceId)).rejects.toThrow("incarnation");
      expect(readFileSync(join(h.root, "user.txt"), "utf8")).toBe("unrelated checkout bytes\n");
      expect(h.harness.records.get(h.record.workspaceId)).toEqual(h.record);
      expect(h.harness.cleared).toEqual([]);
      expect(orphans).toEqual([]);
      expect(
        h.fixture.jj(["file", "show", "-r", h.record.recoveryBookmark!, "sub/saved.txt"]).stdout,
      ).toBe("approved subproject bytes\n");
    },
  );

  test("registered matching backing with missing subproject is unavailable, not recreated", async () => {
    const h = await missingSelectionFixture(true);
    rmSync(h.record.cwd, { recursive: true });
    const orphans: string[] = [];
    const recovery = createWorkspaceRecoveryService({
      ...h.harness.deps,
      reportOrphan: (path) => orphans.push(path),
    });
    await expect(recovery.inspect(h.record.workspaceId)).resolves.toMatchObject({
      kind: "unavailable",
      message: expect.stringContaining("selected project directory"),
    });
    await expect(recovery.restore(h.record.workspaceId)).rejects.toThrow(
      "selected project directory",
    );
    expect(await readJjWorkspaceIncarnation(h.root)).toBe(h.record.jjWorkspaceId);
    expect(h.harness.records.get(h.record.workspaceId)).toEqual(h.record);
    expect(h.harness.cleared).toEqual([]);
    expect(orphans).toEqual([]);
  });

  test.each(["absent", "plain-partial"] as const)(
    "missing subproject recovery preserves authorized %s backing restoration",
    async (mode) => {
      const h = await missingSelectionFixture(true);
      h.fixture.jj(["workspace", "forget", "repo-original"]);
      renameSync(h.root, `${h.root}.original`);
      if (mode === "plain-partial") {
        mkdirSync(h.root);
        writeFileSync(join(h.root, "partial.txt"), "retain partial bytes\n");
      }
      const orphans: string[] = [];
      const recovery = createWorkspaceRecoveryService({
        ...h.harness.deps,
        reportOrphan: (path) => orphans.push(path),
      });
      await expect(recovery.restore(h.record.workspaceId)).resolves.toMatchObject({
        action: "restore",
      });
      expect(readFileSync(join(h.root, "sub", "saved.txt"), "utf8")).toBe(
        "approved subproject bytes\n",
      );
      expect(h.harness.records.get(h.record.workspaceId)?.archivedAt).toBeNull();
      if (mode === "plain-partial") {
        expect(orphans).toHaveLength(1);
        expect(readFileSync(join(orphans[0]!, "partial.txt"), "utf8")).toBe(
          "retain partial bytes\n",
        );
      } else expect(orphans).toEqual([]);
    },
  );

  test.each([false, true])(
    "immediate pre-rename check refuses checkout materialized after absent-root planning (subproject=%s)",
    async (subproject) => {
      const h = await missingSelectionFixture(subproject);
      h.fixture.jj(["workspace", "forget", "repo-original"]);
      renameSync(h.root, `${h.root}.original`);
      let materialized = false;
      const orphans: string[] = [];
      const recovery = createWorkspaceRecoveryService({
        ...h.harness.deps,
        isDirectory: async (path) => {
          if (path === h.fixture.repoDir && !materialized) {
            materialized = true;
            mkdirSync(h.root);
            execFileSync("git", ["init", "-b", "main"], { cwd: h.root, stdio: "pipe" });
            writeFileSync(join(h.root, "user.txt"), "arrived after planning\n");
          }
          return existsSync(path) && statSync(path).isDirectory();
        },
        reportOrphan: (path) => orphans.push(path),
      });
      await expect(recovery.restore(h.record.workspaceId)).rejects.toThrow("incarnation");
      expect(materialized).toBe(true);
      expect(readFileSync(join(h.root, "user.txt"), "utf8")).toBe("arrived after planning\n");
      expect(h.harness.records.get(h.record.workspaceId)).toEqual(h.record);
      expect(h.harness.cleared).toEqual([]);
      expect(orphans).toEqual([]);
    },
  );
  test("a surviving backing file cannot be treated as an absent checkout", async () => {
    const h = await missingSelectionFixture(true);
    h.fixture.jj(["workspace", "forget", "repo-original"]);
    renameSync(h.root, `${h.root}.original`);
    writeFileSync(h.root, "unrelated file at backing pathname\n");
    const service = createWorkspaceRecoveryService({
      ...h.harness.deps,
      isDirectory: async (target) => existsSync(target) && statSync(target).isDirectory(),
    });
    await expect(service.inspect(h.record.workspaceId)).resolves.toMatchObject({
      kind: "unavailable",
    });
    await expect(service.restore(h.record.workspaceId)).rejects.toThrow("not a directory");
    expect(readFileSync(h.root, "utf8")).toBe("unrelated file at backing pathname\n");
    expect(h.harness.records.get(h.record.workspaceId)).toEqual(h.record);
    expect(h.harness.cleared).toEqual([]);
  });
});
