import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { resolveRepositoryDefaultBranch } from "../../../utils/checkout-git.js";
import { resolveEffectiveBackend } from "../../../utils/checkout-dispatch.js";
import { createRealpathAwarePathMatcher } from "../../../utils/path.js";
import { runGitCommand } from "../../../utils/run-git-command.js";
import {
  deleteJjBookmark,
  jjRevisionResolves,
  resolveJjPinnedRevision,
  restoreJjWorkspace,
  rollbackJjWorkspace,
} from "../../../utils/worktree-jj.js";
import { writePaseoWorktreeMetadata } from "../../../utils/worktree-metadata.js";
import {
  createWorktree,
  isPaseoOwnedWorktreeCwd,
  mapWorkspaceCwdToWorktree,
  rollbackCreatedPaseoWorktree,
  type WorktreeSource,
} from "../../../utils/worktree.js";
import { WorktreeRequestError, toWorktreeRequestError } from "../../worktree-errors.js";
import {
  resolveWorkspaceDisplayName,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";

export type WorkspaceRecoveryAction = "unarchive" | "restore";

export type WorkspaceRecoveryState =
  | {
      kind: "recoverable";
      workspaceId: string;
      workspaceName: string;
      action: WorkspaceRecoveryAction;
      branch: string | null;
    }
  | {
      kind: "unavailable";
      workspaceId: string;
      reason:
        | "workspace_not_found"
        | "workspace_not_archived"
        | "project_not_found"
        | "project_directory_missing"
        | "workspace_directory_missing"
        | "worktree_branch_missing";
      message: string;
    };

export interface WorkspaceRecoveryService {
  inspect(workspaceId: string): Promise<WorkspaceRecoveryState>;
  restore(workspaceId: string): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }>;
}

type RecoveryPlan =
  | {
      kind: "unarchive";
      state: Extract<WorkspaceRecoveryState, { kind: "recoverable" }>;
      workspace: PersistedWorkspaceRecord;
    }
  | {
      kind: "restore";
      state: Extract<WorkspaceRecoveryState, { kind: "recoverable" }>;
      workspace: PersistedWorkspaceRecord;
      sourceRepoRoot: string;
    };

type UnavailableRecoveryState = Extract<WorkspaceRecoveryState, { kind: "unavailable" }>;

export function createWorkspaceRecoveryService(deps: {
  paseoHome: string;
  worktreesRoot?: string;
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  getProject: (projectId: string) => Promise<PersistedProjectRecord | null>;
  isDirectory: (path: string) => Promise<boolean>;
  unarchiveWorkspace: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  // jj only: clears the persisted recovery bookmark after a successful
  // restore (the pin bookmark itself is deleted in the repo).
  clearRecoveryPin?: (workspaceId: string) => Promise<void>;
}): WorkspaceRecoveryService {
  async function resolveRecovery(
    workspaceId: string,
  ): Promise<UnavailableRecoveryState | RecoveryPlan> {
    const workspace = await deps.getWorkspace(workspaceId);
    if (!workspace) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_not_found",
        message: "This workspace is no longer known to the host.",
      };
    }
    if (!workspace.archivedAt) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_not_archived",
        message: "This workspace is not archived, but it is unavailable from the host.",
      };
    }

    const project = await deps.getProject(workspace.projectId);
    if (!project) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "project_not_found",
        message: "The project for this archived workspace no longer exists.",
      };
    }

    if (await deps.isDirectory(workspace.cwd)) {
      // A jj workspace whose directory survived a partial deletion (forget
      // succeeded, removal failed) still needs recreation: jj reports "No
      // working copy" there (review fix 6). Only records WITHOUT a recovery
      // pin can plain-unarchive.
      if (workspace.recoveryBookmark && workspace.kind === "worktree") {
        const sourceRepoRoot = workspace.mainRepoRoot ?? project.rootPath;
        if (
          (await resolveEffectiveBackend(sourceRepoRoot)) === "jj" &&
          !(await jjRevisionResolves(sourceRepoRoot, `${basename(workspace.cwd)}@`))
        ) {
          return createRecoveryPlan({ action: "restore", workspace, sourceRepoRoot });
        }
      }
      return createRecoveryPlan({ action: "unarchive", workspace });
    }

    if (workspace.kind !== "worktree") {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "workspace_directory_missing",
        message: "The archived workspace directory no longer exists and cannot be recreated.",
      };
    }
    // COMPAT(worktreeRestoreMissingMainRepoRoot): records created before v0.1.110
    // lack placement ownership; remove the project-root fallback after 2027-01-17.
    const sourceRepoRoot = workspace.mainRepoRoot ?? project.rootPath;
    if (!(await deps.isDirectory(sourceRepoRoot))) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "project_directory_missing",
        message: "The source repository needed to restore this worktree no longer exists.",
      };
    }

    return createRecoveryPlan({ action: "restore", workspace, sourceRepoRoot });
  }

  async function inspect(workspaceId: string): Promise<WorkspaceRecoveryState> {
    const resolved = await resolveRecovery(workspaceId);
    return resolved.kind === "unavailable" ? resolved : resolved.state;
  }

  async function restore(
    workspaceId: string,
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }> {
    const resolved = await resolveRecovery(workspaceId);
    if (resolved.kind === "unavailable") {
      throw new Error(resolved.message);
    }

    if (resolved.kind === "restore") {
      await recreateArchivedWorktree(resolved.workspace, resolved.sourceRepoRoot);
    }
    await deps.unarchiveWorkspace(resolved.workspace);
    if (
      resolved.kind === "restore" &&
      resolved.workspace.recoveryBookmark &&
      deps.clearRecoveryPin
    ) {
      await deps.clearRecoveryPin(resolved.workspace.workspaceId);
    }
    return { workspaceId, action: resolved.kind };
  }

  async function recreateArchivedWorktree(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
  ): Promise<void> {
    if ((await resolveEffectiveBackend(sourceRepoRoot)) === "jj") {
      await recreateArchivedJjWorkspace(workspace, sourceRepoRoot);
      return;
    }
    const source: WorktreeSource = workspace.branch
      ? { kind: "restore", branchName: workspace.branch, baseRef: workspace.baseBranch }
      : {
          kind: "restore-from-base",
          branchName: `restored/${randomUUID().slice(0, 8)}`,
          baseRef: await resolveRecoveryBase(sourceRepoRoot, workspace.baseBranch),
        };

    try {
      await runGitCommand(["worktree", "prune"], { cwd: sourceRepoRoot, timeout: 30_000 });
    } catch {
      // A stale worktree registration is not guaranteed; creation reports any real conflict.
    }

    let previousWorktreePath = workspace.worktreeRoot;
    let hasRecordedWorktreePath = Boolean(previousWorktreePath);
    if (!previousWorktreePath) {
      // COMPAT(worktreeRestoreMissingWorktreeRoot): records created before v0.1.110
      // lack durable backing placement; remove filesystem discovery after 2027-01-17.
      const ownership = await isPaseoOwnedWorktreeCwd(workspace.cwd, {
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
      });
      previousWorktreePath = ownership.allowed
        ? (ownership.worktreePath ?? workspace.cwd)
        : workspace.cwd;
      hasRecordedWorktreePath = ownership.allowed;
    }

    let recreatedWorktreePath: string;
    try {
      const result = await createWorktree({
        cwd: sourceRepoRoot,
        worktreeSlug: basename(previousWorktreePath),
        source,

        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
        ...(hasRecordedWorktreePath ? { worktreePath: previousWorktreePath } : {}),
      });
      recreatedWorktreePath = result.worktreePath;
    } catch (error) {
      throw toWorktreeRequestError(error);
    }

    try {
      const recreatedWorkspacePath = mapWorkspaceCwdToWorktree({
        sourceWorktreePath: previousWorktreePath,
        workspaceCwd: workspace.cwd,
        targetWorktreePath: recreatedWorktreePath,
      });
      if (!createRealpathAwarePathMatcher(workspace.cwd)(recreatedWorkspacePath)) {
        throw new WorktreeRequestError({
          code: "unknown",
          message: `Recreated worktree diverged from ${workspace.cwd}: ${recreatedWorkspacePath}`,
        });
      }
      if (!(await deps.isDirectory(recreatedWorkspacePath))) {
        throw new WorktreeRequestError({
          code: "unknown",
          message: `Selected project directory is missing from the restored worktree: ${recreatedWorkspacePath}`,
        });
      }
    } catch (error) {
      return rollbackCreatedPaseoWorktree(
        {
          cwd: sourceRepoRoot,
          worktreePath: recreatedWorktreePath,
          teardownCwds: [],
          paseoHome: deps.paseoHome,
          worktreesBaseRoot: deps.worktreesRoot,
        },
        error,
      );
    }
  }

  /**
   * jj restore: the workspace is re-created at its pinned recovery bookmark.
   * `jj workspace add --revision <pin>` puts the pinned change back as the
   * workspace's parent (verified on 0.45.1). An unresolved or missing pin
   * BLOCKS with an explanation — never silently restore from base (plan §6).
   */
  async function recreateArchivedJjWorkspace(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
  ): Promise<void> {
    const pin = workspace.recoveryBookmark;
    if (pin !== null && !pin.startsWith("paseo/recovery/")) {
      // Trust boundary (review fix 5): a stored value outside the private pin
      // namespace is not a recovery handle — refuse instead of resolving or
      // deleting an arbitrary bookmark.
      throw new WorktreeRequestError({
        code: "unknown",
        message: `The stored recovery reference ${pin} is not a Paseo recovery pin; refusing to restore or delete it.`,
      });
    }
    if (!pin) {
      throw new WorktreeRequestError({
        code: "unknown",
        message:
          "This jj workspace has no recovery pin, so its changes cannot be located to restore. The changes may still be reachable with jj (op log / evolog) on the host.",
      });
    }
    if (!(await jjRevisionResolves(sourceRepoRoot, pin))) {
      throw new WorktreeRequestError({
        code: "unknown",
        message: `The recovery pin ${pin} no longer resolves in the repository, so this jj workspace cannot be restored safely.`,
      });
    }

    let previousWorktreePath = workspace.worktreeRoot;
    if (!previousWorktreePath) {
      // COMPAT(worktreeRestoreMissingWorktreeRoot): records created before
      // v0.1.110 lack durable backing placement; remove filesystem discovery
      // after 2027-01-17.
      const ownership = await isPaseoOwnedWorktreeCwd(workspace.cwd, {
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
      });
      previousWorktreePath = ownership.allowed
        ? (ownership.worktreePath ?? workspace.cwd)
        : workspace.cwd;
    }

    const worktreePath = previousWorktreePath;
    try {
      await restoreJjWorkspace({
        cwd: sourceRepoRoot,
        worktreePath,
        workspaceName: basename(worktreePath),
        revision: pin,
      });
    } catch (error) {
      throw toWorktreeRequestError(error);
    }

    // Reconstruct the workspace's pinned-base metadata (review fix 6): the
    // recorded baseBranch is the durable source; without one, no metadata is
    // better than wrong metadata.
    if (workspace.baseBranch) {
      try {
        const pinnedBase = await resolveJjPinnedRevision(sourceRepoRoot, workspace.baseBranch);
        writePaseoWorktreeMetadata(worktreePath, {
          baseRefName: workspace.baseBranch,
          baseRef: pinnedBase,
          ...(workspace.branch ? { jjBookmark: workspace.branch } : {}),
        });
      } catch {
        // Base unresolvable (removed upstream): restore continues without
        // base metadata rather than failing an otherwise-good recovery.
      }
    }

    try {
      const recreatedWorkspacePath = mapWorkspaceCwdToWorktree({
        sourceWorktreePath: worktreePath,
        workspaceCwd: workspace.cwd,
        targetWorktreePath: worktreePath,
      });
      if (!createRealpathAwarePathMatcher(workspace.cwd)(recreatedWorkspacePath)) {
        throw new WorktreeRequestError({
          code: "unknown",
          message: `Recreated workspace diverged from ${workspace.cwd}: ${recreatedWorkspacePath}`,
        });
      }
      if (!(await deps.isDirectory(recreatedWorkspacePath))) {
        throw new WorktreeRequestError({
          code: "unknown",
          message: `Selected project directory is missing from the restored workspace: ${recreatedWorkspacePath}`,
        });
      }
    } catch (error) {
      // The workspace was already re-created; removal is the same rollback
      // shape (forget + directory removal) without a new pin.
      await rollbackJjWorkspace(sourceRepoRoot, basename(worktreePath), worktreePath);
      throw toWorktreeRequestError(error);
    }

    // Restore succeeded: consume the pin bookmark so the workspace name is
    // free and the pin does not linger. The registry field is cleared by the
    // caller after unarchive (clearRecoveryPin dep).
    await deleteJjBookmark(sourceRepoRoot, pin);
  }

  return { inspect, restore };
}

async function resolveRecoveryBase(repoRoot: string, recordedBase: string | null): Promise<string> {
  if (recordedBase) {
    try {
      await runGitCommand(["rev-parse", "--verify", `${recordedBase}^{commit}`], { cwd: repoRoot });
      return recordedBase;
    } catch {
      // The saved base was removed; use the repository default for continued work.
    }
  }
  const defaultBranch = await resolveRepositoryDefaultBranch(repoRoot);
  if (!defaultBranch) {
    throw new WorktreeRequestError({
      code: "unknown",
      message:
        "The saved base is unavailable and the repository has no default branch to restore from.",
    });
  }
  return defaultBranch;
}

function createRecoveryPlan(
  input:
    | { action: "unarchive"; workspace: PersistedWorkspaceRecord }
    | { action: "restore"; workspace: PersistedWorkspaceRecord; sourceRepoRoot: string },
): RecoveryPlan {
  const state = {
    kind: "recoverable" as const,
    workspaceId: input.workspace.workspaceId,
    workspaceName: resolveWorkspaceDisplayName(input.workspace),
    branch: input.workspace.branch,
  };
  if (input.action === "restore") {
    return {
      kind: input.action,
      state: { ...state, action: input.action },
      workspace: input.workspace,
      sourceRepoRoot: input.sourceRepoRoot,
    };
  }
  return {
    kind: input.action,
    state: {
      ...state,
      action: input.action,
    },
    workspace: input.workspace,
  };
}
