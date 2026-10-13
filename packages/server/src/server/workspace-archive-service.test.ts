import { createWorkspaceArchiveAuthorityPorts } from "./workspace-archive-service.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ForgeService } from "../services/forge-service.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { createWorktree, type WorktreeConfig } from "../utils/worktree.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  type ArchiveDependencies,
  type ArchiveResult,
  resolveWorkspaceIdAtPath,
} from "./workspace-archive-service.js";
import { WorkspaceAutomationBlockedError } from "./workspace-automation-gate.js";
import {
  FileBackedWorkspaceRegistry,
  clearWorkspaceRecoveryReference,
  createPersistedWorkspaceRecord,
  createPersistedProjectRecord,
} from "./workspace-registry.js";
import { createWorkspaceRecoveryService } from "./session/workspace-recovery/workspace-recovery-service.js";
import { jjRevisionResolves, listJjWorkspaces } from "../utils/worktree-jj.js";
import { readJjWorkspaceIncarnation } from "../utils/worktree-metadata.js";
import { createJjWorktree } from "../utils/worktree-jj.js";
import { createScratchJjRepo, isJjAvailable } from "../test-utils/jj.js";

const describeIfJj = describe.skipIf(!isJjAvailable());

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createLogger(): Logger {
  const logger = pino({ level: "silent" });
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  return logger;
}

function createGitHubServiceStub(): ForgeService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    }),
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      labels: [],
    }),
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
    getPullRequestCheckoutTarget: async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    }),
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createGitRepo(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "workspace-archive-service-"));
  cleanupPaths.push(tempDir);
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return { tempDir, repoDir };
}

async function createPaseoOwnedWorktree(
  repoDir: string,
  paseoHome: string,
  worktreeSlug: string,
): Promise<WorktreeConfig> {
  return createWorktree({
    cwd: repoDir,
    worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: "main",
      branchName: worktreeSlug,
    },
    runSetup: false,
    paseoHome,
  });
}

interface ArchiveDepsInput {
  paseoHome: string;
  activeWorkspaces: ActiveWorkspaceRef[];
  paseoWorktreesBaseRoot?: string;
  findWorkspaceIdForCwd?: (cwd: string) => Promise<string | null>;
}

interface ArchiveTestDependencies extends ArchiveDependencies {
  activeWorkspaces: ActiveWorkspaceRef[];
  archivedAgentIds: string[];
  archivedSnapshotIds: string[];
}

function createArchiveDeps(input: ArchiveDepsInput): ArchiveTestDependencies {
  const archivedWorkspaceIds = new Set<string>();
  const active = [...input.activeWorkspaces];
  const archivedAgentIds: string[] = [];
  const archivedSnapshotIds: string[] = [];

  return {
    paseoHome: input.paseoHome,
    paseoWorktreesBaseRoot: input.paseoWorktreesBaseRoot,
    github: createGitHubServiceStub(),
    workspaceGitService: {
      getSnapshot: vi.fn(async () => null),
      invalidateWorktrees: () => {},
    } as unknown as Pick<WorkspaceGitService, "getSnapshot" | "invalidateWorktrees">,
    agentManager: {
      listAgents: () => [],
      getAgent: () => null,
      archiveAgent: vi.fn(async (agentId: string) => {
        archivedAgentIds.push(agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, _archivedAt: string) => {
        archivedSnapshotIds.push(agentId);
        return {};
      }),
    },
    agentStorage: {
      listByWorkspace: async (): Promise<StoredAgentRecord[]> => [],
    } as Pick<AgentStorage, "listByWorkspace">,
    findWorkspaceIdForCwd: input.findWorkspaceIdForCwd ?? vi.fn(async () => null),
    listActiveWorkspaces: async () =>
      active.filter((workspace) => !archivedWorkspaceIds.has(workspace.workspaceId)),
    archiveWorkspaceRecord: async (workspaceId: string) => {
      archivedWorkspaceIds.add(workspaceId);
      const index = active.findIndex((workspace) => workspace.workspaceId === workspaceId);
      if (index !== -1) {
        active.splice(index, 1);
      }
    },
    emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
    markWorkspaceArchiving: vi.fn(),
    clearWorkspaceArchiving: vi.fn(),
    killTerminalsForWorkspace: vi.fn(async () => {}),
    sessionLogger: createLogger(),
    activeWorkspaces: active,
    archivedAgentIds,
    archivedSnapshotIds,
  };
}

function assertArchiveResult(
  result: ArchiveResult,
  expected: {
    archivedWorkspaceIds: string[];
    removedDirectory: boolean;
  },
): void {
  expect(result.archivedWorkspaceIds).toEqual(expected.archivedWorkspaceIds);
  expect(result.removedDirectory).toBe(expected.removedDirectory);
}

describe("archiveByScope", () => {
  test("workspace scope archives the record and removes the directory on last reference", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "last-ref-workspace");
    const workspaceId = "ws-last-ref";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-last-ref-workspace",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("workspace scope runs teardown while keeping a directory referenced by a sibling", async () => {
    const { tempDir, repoDir } = createGitRepo();
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/shared-teardown.log', 'ok')\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "shared teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "sibling-workspace");
    const workspaceA = "ws-sibling-a";
    const workspaceB = "ws-sibling-b";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "local_checkout" },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: workspaceA },
        requestId: "req-sibling-workspace",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceA],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
    expect(readFileSync(path.join(repoDir, "shared-teardown.log"), "utf8")).toBe("ok");
  });

  test("workspace scope skips teardown while repository automation is blocked", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const marker = path.join(repoDir, "blocked-teardown.log");
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [`node -e "require('fs').writeFileSync('${marker}', 'unsafe')"`],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "blocked teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "blocked-teardown");
    const workspaceId = "ws-blocked-teardown";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        {
          workspaceId,
          cwd: worktree.worktreePath,
          kind: "worktree",
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
        },
      ],
    });
    deps.assertWorkspaceAutomationAllowed = async () => {
      throw new WorkspaceAutomationBlockedError({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/paseo",
      });
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-blocked-teardown",
    });

    expect(result.archivedWorkspaceIds).toEqual([workspaceId]);
    expect(existsSync(marker)).toBe(false);
  });

  test("workspace scope keeps a worktree for an active workspace in a subdirectory", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "subdirectory-sibling");
    const sourceWorkspaceId = "ws-subdirectory-source";
    const siblingWorkspaceId = "ws-subdirectory-sibling";
    const siblingDirectory = path.join(worktree.worktreePath, "packages", "app");
    mkdirSync(siblingDirectory, { recursive: true });

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: sourceWorkspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: siblingWorkspaceId,
            cwd: siblingDirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: sourceWorkspaceId },
        requestId: "req-subdirectory-sibling",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [sourceWorkspaceId],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("archiving a subdirectory workspace keeps its active worktree root", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "subdirectory-target");
    const rootWorkspaceId = "ws-subdirectory-root";
    const subdirectoryWorkspaceId = "ws-subdirectory-target";
    const subdirectory = path.join(worktree.worktreePath, "packages", "app");
    mkdirSync(subdirectory, { recursive: true });

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: rootWorkspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: subdirectoryWorkspaceId,
            cwd: subdirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: subdirectoryWorkspaceId },
        requestId: "req-subdirectory-target",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [subdirectoryWorkspaceId],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("workspace scope runs teardown from the exact nested workspace before deleting its worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const nestedRelative = path.join("packages", "app");
    const sourceNested = path.join(repoDir, nestedRelative);
    mkdirSync(sourceNested, { recursive: true });
    writeFileSync(
      path.join(sourceNested, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/nested-teardown.log', process.cwd())\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "nested teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "nested-teardown");
    const workspaceCwd = path.join(worktree.worktreePath, nestedRelative);
    const matchesWorkspaceCwd = createRealpathAwarePathMatcher(workspaceCwd);
    const workspaceId = "ws-nested-teardown";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId,
            cwd: workspaceCwd,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
            mainRepoRoot: repoDir,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-nested-teardown",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(
      matchesWorkspaceCwd(readFileSync(path.join(repoDir, "nested-teardown.log"), "utf8")),
    ).toBe(true);
  });

  test("worktree scope archives root and subdirectory workspaces before removing the backing worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const nestedRelative = path.join("packages", "app");
    const sourceNested = path.join(repoDir, nestedRelative);
    mkdirSync(sourceNested, { recursive: true });
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"const fs=require('fs');const out=process.env.PASEO_SOURCE_CHECKOUT_PATH+'/root-scope-teardown.log';if(fs.existsSync(out))process.exit(2);fs.writeFileSync(out,'ok')\"",
          ],
        },
      }),
    );
    writeFileSync(
      path.join(sourceNested, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH+'/nested-scope-teardown.log','ok')\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "scope teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "worktree-scope");
    const workspaceA = "ws-worktree-a";
    const workspaceB = "ws-worktree-b";
    const workspaceC = "ws-worktree-subdirectory";
    const subdirectory = path.join(worktree.worktreePath, nestedRelative);

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: workspaceA,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: workspaceB,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: workspaceC,
            cwd: subdirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-worktree-scope",
      },
    );

    expect(result.archivedWorkspaceIds).toEqual(
      expect.arrayContaining([workspaceA, workspaceB, workspaceC]),
    );
    expect(result.archivedWorkspaceIds).toHaveLength(3);
    expect(result.removedDirectory).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(readFileSync(path.join(repoDir, "root-scope-teardown.log"), "utf8")).toBe("ok");
    expect(readFileSync(path.join(repoDir, "nested-scope-teardown.log"), "utf8")).toBe("ok");
  });

  test("workspace scope never removes a non-Paseo-owned directory", async () => {
    const { tempDir } = createGitRepo();
    const localCheckoutDir = mkdtempSync(path.join(tempDir, "local-checkout-"));
    const workspaceId = "ws-local-checkout";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome: path.join(tempDir, ".paseo"),
        activeWorkspaces: [{ workspaceId, cwd: localCheckoutDir, kind: "local_checkout" }],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-local-checkout",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: false,
    });
    expect(existsSync(localCheckoutDir)).toBe(true);
  });

  test("worktree scope keeps the directory when one record teardown fails", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "partial-failure");
    const workspaceA = "ws-partial-a";
    const workspaceB = "ws-partial-b";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
        { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (workspaceId: string) => {
      if (workspaceId === workspaceA) {
        throw new Error("intentional teardown failure");
      }
      return originalArchiveWorkspaceRecord(workspaceId);
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: worktree.worktreePath },
      requestId: "req-partial-failure",
    });

    expect(result.archivedWorkspaceIds).toEqual([workspaceB]);
    expect(result.archivedWorkspaceIds).not.toContain(workspaceA);
    expect(result.removedDirectory).toBe(false);
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("workspace scope with unknown workspace id is a clean no-op", async () => {
    const { tempDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = vi.fn(async (workspaceId: string) => {
      return originalArchiveWorkspaceRecord(workspaceId);
    });

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: "ws-does-not-exist" },
      requestId: "req-unknown-workspace",
    });

    assertArchiveResult(result, {
      archivedWorkspaceIds: [],
      removedDirectory: false,
    });
    expect(deps.markWorkspaceArchiving).not.toHaveBeenCalled();
    expect(deps.archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(deps.emitWorkspaceUpdatesForWorkspaceIds).not.toHaveBeenCalled();
  });

  test.each(["intact", "missing"] as const)(
    "worktree scope removes an owned directory with zero matching records and %s Git administration",
    async (gitAdministration) => {
      const { tempDir, repoDir } = createGitRepo();
      const paseoHome = path.join(tempDir, ".paseo");
      const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "zero-records");
      if (gitAdministration === "missing") {
        const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
          cwd: worktree.worktreePath,
        })
          .toString()
          .trim();
        rmSync(gitDir, { recursive: true, force: true });
      }
      const dependencies = createArchiveDeps({ paseoHome, activeWorkspaces: [] });
      const invalidateWorktrees = vi.fn();
      dependencies.workspaceGitService.invalidateWorktrees = invalidateWorktrees;

      const result = await archiveByScope(dependencies, {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-zero-records",
      });

      assertArchiveResult(result, {
        archivedWorkspaceIds: [],
        removedDirectory: true,
      });
      expect(existsSync(worktree.worktreePath)).toBe(false);
      expect(invalidateWorktrees).toHaveBeenCalledTimes(1);
    },
  );

  test("marks archiving, emits an upsert carrying the archiving state, then clears it and emits a remove", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "lifecycle");
    const workspaceId = "ws-lifecycle";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });

    const archivingByWorkspaceId = new Map<string, string>();
    type LifecycleEvent =
      | { type: "mark"; workspaceIds: string[]; archivingAt: string }
      | {
          type: "emit";
          workspaceIds: string[];
          updates: Array<{
            kind: "upsert" | "remove";
            workspaceId: string;
            archivingAt: string | null;
          }>;
        }
      | { type: "archive"; workspaceId: string }
      | { type: "clear"; workspaceIds: string[] };
    const events: LifecycleEvent[] = [];

    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (id: string) => {
      await originalArchiveWorkspaceRecord(id);
      events.push({ type: "archive", workspaceId: id });
    };
    deps.markWorkspaceArchiving = vi.fn((workspaceIds: Iterable<string>, archivingAt: string) => {
      for (const id of workspaceIds) {
        archivingByWorkspaceId.set(id, archivingAt);
      }
      events.push({ type: "mark", workspaceIds: Array.from(workspaceIds), archivingAt });
    });
    deps.clearWorkspaceArchiving = vi.fn((workspaceIds: Iterable<string>) => {
      for (const id of workspaceIds) {
        archivingByWorkspaceId.delete(id);
      }
      events.push({ type: "clear", workspaceIds: Array.from(workspaceIds) });
    });
    deps.emitWorkspaceUpdatesForWorkspaceIds = vi.fn(async (workspaceIds: Iterable<string>) => {
      const ids = Array.from(workspaceIds);
      const activeIds = new Set<string>();
      for (const workspace of deps.activeWorkspaces) {
        activeIds.add(workspace.workspaceId);
      }
      const updates: Array<{
        kind: "upsert" | "remove";
        workspaceId: string;
        archivingAt: string | null;
      }> = [];
      for (const id of ids) {
        const archivingAt = archivingByWorkspaceId.get(id) ?? null;
        if (archivingAt && activeIds.has(id)) {
          updates.push({ kind: "upsert", workspaceId: id, archivingAt });
        } else {
          updates.push({ kind: "remove", workspaceId: id, archivingAt: null });
        }
      }
      events.push({ type: "emit", workspaceIds: ids, updates });
    });

    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-lifecycle",
    });

    expect(events.map((event) => event.type)).toEqual(["mark", "emit", "archive", "clear", "emit"]);

    const firstEmit = events[1] as Extract<LifecycleEvent, { type: "emit" }>;
    expect(firstEmit.workspaceIds).toEqual([workspaceId]);
    expect(firstEmit.updates).toEqual([
      { kind: "upsert", workspaceId, archivingAt: expect.any(String) },
    ]);

    const secondEmit = events[4] as Extract<LifecycleEvent, { type: "emit" }>;
    expect(secondEmit.workspaceIds).toEqual([workspaceId]);
    expect(secondEmit.updates).toEqual([{ kind: "remove", workspaceId, archivingAt: null }]);
  });

  test("archives stored snapshots only for the target workspace", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "snapshot-scope");
    const targetWorkspaceId = "ws-snapshot-target";
    const otherWorkspaceId = "ws-snapshot-other";
    const liveAgentId = "agent-live";
    const targetStoredAgentId = "agent-stored-target";
    const otherStoredAgentId = "agent-stored-other";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: targetWorkspaceId, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    deps.agentManager = {
      listAgents: () => [{ id: liveAgentId, workspaceId: targetWorkspaceId }] as ManagedAgent[],
      getAgent: (agentId: string) =>
        agentId === liveAgentId ? ({ id: liveAgentId } as ManagedAgent) : null,
      archiveAgent: vi.fn(async (agentId: string) => {
        deps.archivedAgentIds.push(agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, _archivedAt: string) => {
        deps.archivedSnapshotIds.push(agentId);
        return {};
      }),
    };
    deps.agentStorage = {
      listByWorkspace: async (workspaceId: string) =>
        workspaceId === targetWorkspaceId
          ? ([
              { id: targetStoredAgentId, workspaceId: targetWorkspaceId, archivedAt: null },
            ] as StoredAgentRecord[])
          : ([
              { id: otherStoredAgentId, workspaceId: otherWorkspaceId, archivedAt: null },
            ] as StoredAgentRecord[]),
    } as Pick<AgentStorage, "listByWorkspace">;

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: targetWorkspaceId },
      requestId: "req-snapshot-scope",
    });

    assertArchiveResult(result, {
      archivedWorkspaceIds: [targetWorkspaceId],
      removedDirectory: true,
    });
    expect(result.archivedAgentIds).toContain(liveAgentId);
    expect(result.archivedAgentIds).toContain(targetStoredAgentId);
    expect(result.archivedAgentIds).not.toContain(otherStoredAgentId);
    expect(deps.archivedSnapshotIds).toEqual([targetStoredAgentId]);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("archives the durable snapshot when an observed live agent closes before teardown", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const workspaceId = "ws-live-teardown-race";
    const agentId = "agent-live-teardown-race";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: repoDir, kind: "local_checkout" }],
    });
    deps.agentManager = {
      listAgents: () => [{ id: agentId, workspaceId }] as ManagedAgent[],
      getAgent: () => null,
      archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
      archiveSnapshot: vi.fn(async (id: string) => {
        deps.archivedSnapshotIds.push(id);
        return {};
      }),
    };
    deps.agentStorage = {
      list: async () => [{ id: agentId, workspaceId, archivedAt: null }] as StoredAgentRecord[],
    } as Pick<AgentStorage, "list">;

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-live-teardown-race",
    });

    expect(result.archivedAgentIds).toContain(agentId);
    expect(deps.archivedSnapshotIds).toEqual([agentId]);
    expect(deps.agentManager.archiveAgent).not.toHaveBeenCalled();
  });

  test("worktree scope archives three workspaces on the directory and removes it", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "worktree-scope-n3");
    const workspaceA = "ws-worktree-n3-a";
    const workspaceB = "ws-worktree-n3-b";
    const workspaceC = "ws-worktree-n3-c";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceC, cwd: worktree.worktreePath, kind: "local_checkout" },
        ],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-worktree-scope-n3",
      },
    );

    expect(result.archivedWorkspaceIds).toEqual(
      expect.arrayContaining([workspaceA, workspaceB, workspaceC]),
    );
    expect(result.archivedWorkspaceIds).toHaveLength(3);
    expect(result.removedDirectory).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });
});

describe("resolveWorkspaceIdAtPath", () => {
  test("prefers the worktree-kind record on an exact cwd tie", async () => {
    const targetPath = "/worktrees/repo/feature";

    const result = await resolveWorkspaceIdAtPath(
      {
        listActiveWorkspaces: async () => [
          { workspaceId: "ws-local", cwd: targetPath, kind: "local_checkout" },
          { workspaceId: "ws-worktree", cwd: targetPath, kind: "worktree" },
        ],
        findWorkspaceIdForCwd: vi.fn(async () => "ws-local"),
      },
      targetPath,
    );

    expect(result).toBe("ws-worktree");
  });

  test("falls back to the path resolver when there is no exact match", async () => {
    const targetPath = "/worktrees/repo/feature";

    const result = await resolveWorkspaceIdAtPath(
      {
        listActiveWorkspaces: async () => [
          { workspaceId: "ws-nested", cwd: "/worktrees/repo", kind: "worktree" },
        ],
        findWorkspaceIdForCwd: vi.fn(async () => "ws-nested"),
      },
      targetPath,
    );

    expect(result).toBe("ws-nested");
  });
});

describeIfJj("archiveByScope on jj (sibling recovery authority)", () => {
  test("persists the pin for every sibling record over the backing checkout", async () => {
    const fixture = createScratchJjRepo({ colocate: true, files: { "readme.md": "hello\n" } });
    cleanupPaths.push(fixture.dir);
    const base = fixture.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]).stdout.trim();
    fixture.jj(["bookmark", "create", "main", "-r", base]);
    const worktreesRoot = path.join(fixture.dir, "worktrees-home");
    mkdirSync(worktreesRoot, { recursive: true });

    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "sibling-ws",
      source: { kind: "branch-off", baseBranch: "main", branchName: "feat/sibling" },
      worktreesRoot,
    });
    fixture.jj(["describe", "-m", "sibling work"], created.worktreePath);

    // Two records share the backing checkout: the root record (this request)
    // and a subproject record archived EARLIER — the latter must ALSO receive
    // the pin or it becomes unrestorable once the directory is quarantined.
    const rootRef: ActiveWorkspaceRef = {
      workspaceId: "ws-root",
      cwd: created.worktreePath,
      kind: "worktree",
      worktreeRoot: created.worktreePath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: fixture.repoDir,
    };
    const pinsByWorkspace = new Map<string, string>();
    const incarnation = readJjWorkspaceIncarnation(created.worktreePath)!;
    const siblingRecords = new Map(
      ["ws-root", "ws-archived-earlier"].map((workspaceId) => [
        workspaceId,
        createPersistedWorkspaceRecord({
          ...rootRef,
          workspaceId,
          projectId: "project",
          displayName: workspaceId,
          jjWorkspaceId: incarnation,
          createdAt: "now",
          updatedAt: "now",
          archivedAt: workspaceId === "ws-root" ? null : "earlier",
        }),
      ]),
    );

    const deps = createArchiveDeps({
      paseoHome: fixture.dir,
      paseoWorktreesBaseRoot: worktreesRoot,
      activeWorkspaces: [rootRef],
      findWorkspaceIdForCwd: async () => "ws-root",
    });
    deps.getWorkspace = async (id) => siblingRecords.get(id) ?? null;
    deps.findWorkspaceIdsForBackingPath = async () => ["ws-root", "ws-archived-earlier"];
    deps.setWorkspaceRecoveryPin = async (workspaceId, pin) => {
      pinsByWorkspace.set(workspaceId, pin);
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: "ws-root" },
      requestId: "archive-jj-sibling",
    });

    assertArchiveResult(result, {
      archivedWorkspaceIds: ["ws-root"],
      removedDirectory: true,
    });
    expect([...pinsByWorkspace.keys()].sort()).toEqual(["ws-archived-earlier", "ws-root"]);
    expect(new Set(pinsByWorkspace.values()).size).toBe(1); // one shared pin
  });
});

describeIfJj("jj durable archive and recovery", () => {
  test("archives sequential subproject siblings, reloads registry, and retains their pin after reference retirement", async () => {
    const fixture = createScratchJjRepo({ files: { "subproject/file.txt": "recover me\n" } });
    cleanupPaths.push(fixture.dir);
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    const worktreesRoot = path.join(fixture.dir, "custom-worktrees");
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "durable",
      worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature" },
    });
    const filePath = path.join(fixture.dir, "registry", "workspaces.json");
    const registry = new FileBackedWorkspaceRegistry(filePath, pino({ level: "silent" }));
    await registry.initialize();
    const now = new Date().toISOString();
    for (const [workspaceId, cwd] of [
      ["ws-sub", path.join(created.worktreePath, "subproject")],
      ["ws-root", created.worktreePath],
    ]) {
      await registry.upsert(
        createPersistedWorkspaceRecord({
          workspaceId,
          cwd,
          projectId: "project",
          kind: "worktree",
          displayName: workspaceId,
          branch: "feature",
          worktreeRoot: created.worktreePath,
          jjWorkspaceId: readJjWorkspaceIncarnation(created.worktreePath)!,
          baseBranch: "main",
          mainRepoRoot: fixture.repoDir,
          isPaseoOwnedWorktree: true,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    const deps = createArchiveDeps({
      paseoHome: fixture.dir,
      paseoWorktreesBaseRoot: worktreesRoot,
      activeWorkspaces: [],
    });
    deps.getWorkspace = (id) => registry.get(id);
    deps.listActiveWorkspaces = async () =>
      (await registry.list()).filter((record) => !record.archivedAt);
    deps.archiveWorkspaceRecord = async (id) => {
      await registry.archive(id, now);
    };
    deps.findWorkspaceIdForCwd = async () => "ws-root";
    deps.findWorkspaceIdsForBackingPath = async (backingPath) =>
      (await registry.list())
        .filter((record) => record.worktreeRoot === backingPath)
        .map((record) => record.workspaceId);
    deps.setWorkspaceRecoveryPin = async (id, pin) => {
      await registry.update(id, (record) => ({ ...record, recoveryBookmark: pin }));
    };
    const first = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: "ws-sub" },
      requestId: "first",
    });
    expect(first.removedDirectory).toBe(false);
    const second = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: "ws-root" },
      requestId: "second",
    });
    expect(second.removedDirectory).toBe(true);
    const reloaded = new FileBackedWorkspaceRegistry(filePath, pino({ level: "silent" }));
    await reloaded.initialize();
    const sub = await reloaded.get("ws-sub");
    const root = await reloaded.get("ws-root");
    expect(sub?.recoveryBookmark).toMatch(/^paseo\/recovery\//);
    expect(root?.recoveryBookmark).toBe(sub?.recoveryBookmark);
    expect(sub?.jjWorkspaceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(root?.jjWorkspaceId).toBe(sub?.jjWorkspaceId);
    const project = createPersistedProjectRecord({
      projectId: "project",
      rootPath: fixture.repoDir,
      kind: "git",
      displayName: "project",
      createdAt: now,
      updatedAt: now,
    });
    const recovery = createWorkspaceRecoveryService({
      paseoHome: fixture.dir,
      worktreesRoot,
      getWorkspace: (id) => reloaded.get(id),
      getProject: async () => project,
      isDirectory: async (dir) => existsSync(dir),
      unarchiveWorkspace: async (record) => {
        await reloaded.update(record.workspaceId, (current) => ({ ...current, archivedAt: null }));
      },
      clearRecoveryPin: async (id, expectedPin) => {
        await reloaded.update(id, (record) =>
          record.recoveryBookmark === expectedPin ? { ...record, recoveryBookmark: null } : record,
        );
      },
    });
    await expect(recovery.restore("ws-sub")).resolves.toEqual({
      workspaceId: "ws-sub",
      action: "restore",
    });
    expect(readFileSync(path.join(created.worktreePath, "subproject", "file.txt"), "utf8")).toBe(
      "recover me\n",
    );
    expect(await jjRevisionResolves(fixture.repoDir, sub!.recoveryBookmark!)).toBe(true);
    await expect(recovery.restore("ws-root")).resolves.toEqual({
      workspaceId: "ws-root",
      action: "unarchive",
    });
    expect(await jjRevisionResolves(fixture.repoDir, sub!.recoveryBookmark!)).toBe(true);
    expect((await reloaded.get("ws-sub"))?.recoveryBookmark).toBeNull();
    expect((await reloaded.get("ws-root"))?.recoveryBookmark).toBeNull();
  });
});

describeIfJj("jj archive with legacy placement", () => {
  test("refuses an unknown legacy incarnation before archiving records or touching a live checkout", async () => {
    const fixture = createScratchJjRepo({ files: { "file.txt": "keep live\n" } });
    cleanupPaths.push(fixture.dir);
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    const worktreesRoot = path.join(fixture.dir, "custom-worktrees");
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "unknown",
      worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "unknown-feature" },
    });
    const record = createPersistedWorkspaceRecord({
      workspaceId: "legacy",
      projectId: "project",
      cwd: created.worktreePath,
      worktreeRoot: created.worktreePath,
      kind: "worktree",
      displayName: "legacy",
      mainRepoRoot: fixture.repoDir,
      isPaseoOwnedWorktree: true,
      createdAt: "now",
      updatedAt: "now",
    });
    const deps = createArchiveDeps({
      paseoHome: fixture.dir,
      paseoWorktreesBaseRoot: worktreesRoot,
      activeWorkspaces: [record],
    });
    deps.getWorkspace = async () => record;
    await expect(
      archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId: "legacy" },
        requestId: "unknown",
      }),
    ).rejects.toThrow("unknown or different incarnation");
    expect(await deps.listActiveWorkspaces()).toEqual([record]);
    expect(readFileSync(path.join(created.worktreePath, "file.txt"), "utf8")).toBe("keep live\n");
    expect((await listJjWorkspaces(fixture.repoDir)).map((entry) => entry.name).sort()).toEqual([
      "default",
      "unknown",
    ]);
  });
  test("routes a live native jj backing path safely when mainRepoRoot is absent", async () => {
    const fixture = createScratchJjRepo({ colocate: false, files: { "file.txt": "safe\n" } });
    cleanupPaths.push(fixture.dir);
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    const worktreesRoot = path.join(fixture.dir, "custom-worktrees");
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "legacy-placement",
      worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "feature-legacy" },
    });
    writeFileSync(path.join(created.worktreePath, "unsnapshotted.txt"), "capture me\n");
    const deps = createArchiveDeps({
      paseoHome: fixture.dir,
      paseoWorktreesBaseRoot: worktreesRoot,
      activeWorkspaces: [
        {
          workspaceId: "ws-legacy",
          cwd: created.worktreePath,
          kind: "worktree",
          worktreeRoot: created.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: null,
        },
      ],
    });
    const legacyRecord = createPersistedWorkspaceRecord({
      workspaceId: "ws-legacy",
      projectId: "project",
      cwd: created.worktreePath,
      worktreeRoot: created.worktreePath,
      kind: "worktree",
      isPaseoOwnedWorktree: true,
      jjWorkspaceId: readJjWorkspaceIncarnation(created.worktreePath)!,
      displayName: "legacy",
      createdAt: "now",
      updatedAt: "now",
    });
    deps.getWorkspace = async () => legacyRecord;
    let pin = "";
    deps.findWorkspaceIdsForBackingPath = async () => ["ws-legacy"];
    deps.setWorkspaceRecoveryPin = async (_id, value) => {
      pin = value;
    };
    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: "ws-legacy" },
      requestId: "legacy",
    });
    expect(result.removedDirectory).toBe(true);
    expect((await listJjWorkspaces(fixture.repoDir)).map((entry) => entry.name)).toEqual([
      "default",
    ]);
    expect(fixture.jj(["file", "show", "-r", pin, "unsnapshotted.txt"]).stdout).toBe(
      "capture me\n",
    );
  });
});

describeIfJj("jj shared archive/recovery lifecycle", () => {
  async function lifecycleHarness() {
    const fixture = createScratchJjRepo({ colocate: false, files: { "base.txt": "base\n" } });
    cleanupPaths.push(fixture.dir);
    fixture.jj(["bookmark", "create", "main", "-r", "@-"]);
    const worktreesRoot = path.join(fixture.dir, "custom-worktrees");
    const created = await createJjWorktree({
      cwd: fixture.repoDir,
      worktreeSlug: "lifecycle",
      worktreesRoot,
      source: { kind: "branch-off", baseBranch: "main", branchName: "lifecycle-feature" },
    });
    const registry = new FileBackedWorkspaceRegistry(
      path.join(fixture.dir, "registry.json"),
      pino({ level: "silent" }),
    );
    await registry.initialize();
    const now = new Date().toISOString();
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "lifecycle-a",
        jjWorkspaceId: readJjWorkspaceIncarnation(created.worktreePath)!,
        projectId: "project",
        cwd: created.worktreePath,
        worktreeRoot: created.worktreePath,
        kind: "worktree",
        displayName: "lifecycle",
        branch: "lifecycle-feature",
        baseBranch: "main",
        mainRepoRoot: fixture.repoDir,
        isPaseoOwnedWorktree: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const project = createPersistedProjectRecord({
      projectId: "project",
      rootPath: fixture.repoDir,
      kind: "git",
      displayName: "project",
      createdAt: now,
      updatedAt: now,
    });
    const logs: Array<Record<string, unknown>> = [];
    const deps = createArchiveDeps({
      paseoHome: fixture.dir,
      paseoWorktreesBaseRoot: worktreesRoot,
      activeWorkspaces: [],
    });
    deps.sessionLogger = pino(
      { level: "warn" },
      {
        write: (message) => {
          logs.push(JSON.parse(message));
        },
      },
    );
    deps.getWorkspace = (id) => registry.get(id);
    deps.listActiveWorkspaces = async () =>
      (await registry.list()).filter((record) => !record.archivedAt);
    deps.archiveWorkspaceRecord = async (id) => {
      await registry.archive(id, now);
    };
    deps.findWorkspaceIdForCwd = async () => "lifecycle-a";
    deps.findWorkspaceIdsForBackingPath = async () => ["lifecycle-a"];
    deps.setWorkspaceRecoveryPin = async (id, pin) => {
      await registry.update(id, (record) => ({ ...record, recoveryBookmark: pin }));
    };
    const recoveryDeps: Parameters<typeof createWorkspaceRecoveryService>[0] = {
      paseoHome: fixture.dir,
      worktreesRoot,
      getWorkspace: (id) => registry.get(id),
      getProject: async () => project,
      isDirectory: async (dir) => existsSync(dir),
      unarchiveWorkspace: async (record) => {
        await registry.update(record.workspaceId, (current) => ({ ...current, archivedAt: null }));
      },
      clearRecoveryPin: (id, pin) => clearWorkspaceRecoveryReference(registry, id, pin),
    };
    const archive = (overrides: Partial<ArchiveDependencies> = {}) =>
      archiveByScope(
        { ...deps, ...overrides },
        { scope: { kind: "workspace", workspaceId: "lifecycle-a" }, requestId: "lifecycle" },
      );
    return { fixture, created, registry, deps, recoveryDeps, archive, logs };
  }

  test("a restore waits for in-flight archive pin persistence before resolving its plan", async () => {
    const h = await lifecycleHarness();
    writeFileSync(path.join(h.created.worktreePath, "archive-write.txt"), "preserve\n");
    const persisted = Promise.withResolvers<void>();
    const finishArchive = Promise.withResolvers<void>();
    const recoveryPlacementRead = Promise.withResolvers<void>();
    const directoryChecks: string[] = [];
    const archiving = h.archive({
      setWorkspaceRecoveryPin: async (id, pin, expected) => {
        await h.deps.setWorkspaceRecoveryPin!(id, pin, expected);
        persisted.resolve();
        await finishArchive.promise;
      },
    });
    await persisted.promise;
    const service = createWorkspaceRecoveryService({
      ...h.recoveryDeps,
      getWorkspace: async (id) => {
        recoveryPlacementRead.resolve();
        return h.registry.get(id);
      },
      isDirectory: async (dir) => {
        directoryChecks.push(dir);
        return existsSync(dir);
      },
    });
    const restoring = service.restore("lifecycle-a");
    await recoveryPlacementRead.promise;
    expect(directoryChecks).toEqual([]);
    finishArchive.resolve();
    await expect(archiving).resolves.toMatchObject({ removedDirectory: true });
    await expect(restoring).resolves.toEqual({ workspaceId: "lifecycle-a", action: "restore" });
    expect(readFileSync(path.join(h.created.worktreePath, "archive-write.txt"), "utf8")).toBe(
      "preserve\n",
    );
    expect((await listJjWorkspaces(h.fixture.repoDir)).map((entry) => entry.name).sort()).toEqual([
      "default",
      "lifecycle",
    ]);
    const quarantineLog = h.logs.find((entry) => typeof entry.quarantinePath === "string");
    expect(quarantineLog).toMatchObject({
      msg: "Preserved archived jj workspace directory",
      backingRoot: h.created.worktreePath,
      quarantinePath: expect.any(String),
    });
  });

  test("a new archive waits through successful restore and expected-generation reference clearing", async () => {
    const h = await lifecycleHarness();
    await h.archive();
    const oldPin = (await h.registry.get("lifecycle-a"))!.recoveryBookmark!;
    const atRetirement = Promise.withResolvers<void>();
    const finishRestore = Promise.withResolvers<void>();
    const archivePlacementRead = Promise.withResolvers<void>();
    const service = createWorkspaceRecoveryService({
      ...h.recoveryDeps,
      clearRecoveryPin: async (id, pin, expected) => {
        await h.recoveryDeps.clearRecoveryPin!(id, pin, expected);
        atRetirement.resolve();
        await finishRestore.promise;
      },
    });
    const restoring = service.restore("lifecycle-a");
    await atRetirement.promise;
    writeFileSync(path.join(h.created.worktreePath, "next-generation.txt"), "next generation\n");
    const archiving = h.archive({
      getWorkspace: async (id) => {
        archivePlacementRead.resolve();
        return h.registry.get(id);
      },
    });
    await archivePlacementRead.promise;
    expect((await h.registry.get("lifecycle-a"))?.archivedAt).toBeNull();
    expect(existsSync(h.created.worktreePath)).toBe(true);
    finishRestore.resolve();
    await expect(restoring).resolves.toMatchObject({ action: "restore" });
    await expect(archiving).resolves.toMatchObject({ removedDirectory: true });
    const newPin = (await h.registry.get("lifecycle-a"))!.recoveryBookmark!;
    expect(newPin).not.toBe(oldPin);
    expect(await jjRevisionResolves(h.fixture.repoDir, oldPin)).toBe(true);
    expect(await jjRevisionResolves(h.fixture.repoDir, newPin)).toBe(true);
    expect(h.fixture.jj(["file", "show", "-r", newPin, "next-generation.txt"]).stdout).toBe(
      "next generation\n",
    );
    // A delayed old completion cannot clear the new durable generation.
    await clearWorkspaceRecoveryReference(h.registry, "lifecycle-a", oldPin);
    expect((await h.registry.get("lifecycle-a"))?.recoveryBookmark).toBe(newPin);
    await createWorkspaceRecoveryService(h.recoveryDeps).restore("lifecycle-a");
    expect(readFileSync(path.join(h.created.worktreePath, "next-generation.txt"), "utf8")).toBe(
      "next generation\n",
    );
    expect(await jjRevisionResolves(h.fixture.repoDir, newPin)).toBe(true);
  });
  test.each([
    "incarnation",
    "backing-metadata",
    "source-metadata",
    "contradictory-external",
  ] as const)(
    "managed archive refuses %s before setup/agent/archive effects even with dispatch disabled",
    async (disappearance) => {
      const h = await lifecycleHarness();
      await h.registry.update("lifecycle-a", (record) => ({
        ...record,
        jjWorkspaceManagement: "managed",
        isPaseoOwnedWorktree: false,
        kind: "directory",
      }));
      writeFileSync(path.join(h.created.worktreePath, "preserve.txt"), "preserve live files\n");
      if (disappearance === "incarnation")
        rmSync(path.join(h.created.worktreePath, ".jj", "paseo", "incarnation"));
      if (disappearance === "backing-metadata")
        rmSync(path.join(h.created.worktreePath, ".jj"), { recursive: true, force: true });
      if (disappearance === "source-metadata")
        rmSync(path.join(h.fixture.repoDir, ".jj"), { recursive: true, force: true });
      if (disappearance === "contradictory-external")
        await h.registry.update("lifecycle-a", (record) => ({
          ...record,
          jjWorkspaceManagement: "external",
        }));
      const saved = await h.registry.get("lifecycle-a");
      let effects = 0;
      const oldDispatch = process.env.PASEO_JJ_DISPATCH;
      process.env.PASEO_JJ_DISPATCH = "0";
      try {
        await expect(
          h.archive({
            stopWorkspaceSetup: async () => {
              effects++;
            },
            archiveWorkspaceRecord: async () => {
              effects++;
            },
            killTerminalsForWorkspace: async () => {
              effects++;
            },
          }),
        ).rejects.toThrow(/incarnation|source repository changed|contradicts/);
        expect(effects).toBe(0);
        expect(await h.registry.get("lifecycle-a")).toEqual(saved);
        expect(readFileSync(path.join(h.created.worktreePath, "preserve.txt"), "utf8")).toBe(
          "preserve live files\n",
        );
      } finally {
        if (oldDispatch === undefined) delete process.env.PASEO_JJ_DISPATCH;
        else process.env.PASEO_JJ_DISPATCH = oldDispatch;
      }
    },
  );

  test("jj archive-by-path with no authoritative records refuses before teardown", async () => {
    const h = await lifecycleHarness();
    let effects = 0;
    await expect(
      archiveByScope(
        {
          ...h.deps,
          listActiveWorkspaces: async () => [],
          stopWorkspaceSetup: async () => {
            effects++;
          },
          archiveWorkspaceRecord: async () => {
            effects++;
          },
        },
        {
          scope: { kind: "worktree", targetPath: h.created.worktreePath },
          requestId: "no-authority",
        },
      ),
    ).rejects.toThrow("No workspace record authorizes");
    expect(effects).toBe(0);
    expect(existsSync(h.created.worktreePath)).toBe(true);
  });

  test("production archive ports pin only matching managed sibling incarnations", async () => {
    const h = await lifecycleHarness();
    const matching = (await h.registry.get("lifecycle-a"))!;
    for (const sibling of [
      {
        workspaceId: "earlier",
        jjWorkspaceId: matching.jjWorkspaceId,
        jjWorkspaceManagement: "managed" as const,
        recoveryBookmark: null,
      },
      {
        workspaceId: "unrelated",
        jjWorkspaceId: "older-incarnation",
        jjWorkspaceManagement: "managed" as const,
        recoveryBookmark: "paseo/recovery/older",
      },
      {
        workspaceId: "external",
        jjWorkspaceId: undefined,
        jjWorkspaceManagement: "external" as const,
        recoveryBookmark: null,
      },
      {
        workspaceId: "unknown",
        jjWorkspaceId: undefined,
        jjWorkspaceManagement: undefined,
        recoveryBookmark: null,
      },
    ])
      await h.registry.upsert({
        ...matching,
        ...sibling,
        archivedAt: "earlier",
        isPaseoOwnedWorktree: false,
      });
    const old = await h.registry.get("unrelated");
    const external = await h.registry.get("external");
    const unknown = await h.registry.get("unknown");
    await expect(
      h.archive(createWorkspaceArchiveAuthorityPorts(h.registry)),
    ).resolves.toMatchObject({ removedDirectory: true });
    const pin = (await h.registry.get("lifecycle-a"))?.recoveryBookmark;
    expect((await h.registry.get("earlier"))?.recoveryBookmark).toBe(pin);
    expect(await h.registry.get("unrelated")).toEqual(old);
    expect(await h.registry.get("external")).toEqual(external);
    expect(await h.registry.get("unknown")).toEqual(unknown);
  });
  test("archive preflight refuses a current record moved to another valid managed backing root", async () => {
    const h = await lifecycleHarness();
    const replacement = await createJjWorktree({
      cwd: h.fixture.repoDir,
      worktreeSlug: "other",
      worktreesRoot: path.join(h.fixture.dir, "custom-worktrees"),
      source: { kind: "branch-off", baseBranch: "main", branchName: "other-feature" },
    });
    let reads = 0;
    let effects = 0;
    await expect(
      h.archive({
        getWorkspace: async (id) => {
          reads++;
          if (reads === 3)
            await h.registry.update(id, (current) => ({
              ...current,
              cwd: replacement.worktreePath,
              worktreeRoot: replacement.worktreePath,
              jjWorkspaceId: readJjWorkspaceIncarnation(replacement.worktreePath)!,
              jjWorkspaceManagement: "managed",
            }));
          return h.registry.get(id);
        },
        stopWorkspaceSetup: async () => {
          effects++;
        },
        archiveWorkspaceRecord: async () => {
          effects++;
        },
      }),
    ).rejects.toThrow("backing authority changed");
    expect(effects).toBe(0);
    expect((await h.registry.get("lifecycle-a"))?.archivedAt).toBeNull();
    expect(existsSync(h.created.worktreePath)).toBe(true);
    expect(existsSync(replacement.worktreePath)).toBe(true);
  });
});
