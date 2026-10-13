import { getJjChangeMeta, getJjOperationId } from "../../../utils/checkout-jj.js";
import { runJjCommand } from "../../../utils/run-jj-command.js";
import {
  readJjArchiveCheckpoint,
  restoreJjCheckpoint,
  jjArchiveCheckpointPath,
  readJjCheckpoint,
  validateJjCheckpoint,
  writeJjCheckpoint,
  type JjCheckpoint,
  type JjCheckpointOperation,
  JjCheckpointError,
} from "../../../utils/jj-checkpoint.js";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

import { resolveRepositoryDefaultBranch } from "../../../utils/checkout-git.js";
import { detectVcsBackend, resolveJjRepoIdentity } from "../../../utils/vcs-backend.js";
import { jjWorkspaceAuthority, validatePresentJjWorkspace } from "../../workspace-jj-authority.js";
import { createRealpathAwarePathMatcher } from "../../../utils/path.js";
import {
  withWorkspaceLifecycle,
  workspaceLifecycleKey,
} from "../../../utils/workspace-lifecycle.js";
import { runGitCommand } from "../../../utils/run-git-command.js";
import {
  jjRevisionResolves,
  listJjWorkspaces,
  resolveJjPinnedRevision,
  restoreJjWorkspace,
  rollbackJjWorkspace,
} from "../../../utils/worktree-jj.js";
import {
  assertJjWorkspaceIncarnation,
  writeJjWorkspaceIncarnation,
  writePaseoWorktreeMetadata,
} from "../../../utils/worktree-metadata.js";
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

interface JjRestoreBackingInput {
  workspace: PersistedWorkspaceRecord;
  sourceRepoRoot: string;
  backingRoot: string;
}

type UnavailableRecoveryState = Extract<WorkspaceRecoveryState, { kind: "unavailable" }>;

function assertRecoveryPin(pin: string): void {
  if (!/^paseo\/recovery\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pin)) {
    throw new WorktreeRequestError({
      code: "unknown",
      message: `The stored recovery reference ${pin} is not a Paseo recovery pin; refusing to restore or delete it.`,
    });
  }
}

/** True when `jj workspace list` still registers a workspace at this root. */
async function jjWorkspaceRootRegistered(
  sourceRepoRoot: string,
  worktreeRoot: string,
): Promise<boolean> {
  const matchesRoot = createRealpathAwarePathMatcher(worktreeRoot);
  // Unknown registration cannot authorize unarchive or pin consumption.
  const entries = await listJjWorkspaces(sourceRepoRoot);
  return entries.some((entry) => matchesRoot(entry.root));
}

/**
 * Move a surviving directory aside so `jj workspace add` can recreate the
 * workspace at the original path. All directories are retained; any failure
 * throws (the restore aborts with the directory intact).
 */
async function quarantineSurvivingDirectory(worktreePath: string): Promise<string | null> {
  if (!existsSync(worktreePath)) {
    return null;
  }
  // Preserve even an apparently empty directory: an external write can race
  // an emptiness check. A unique sibling avoids overwriting an earlier orphan.
  const orphanPath = `${worktreePath}.orphan-${randomUUID()}`;
  try {
    mkdirSync(dirname(orphanPath), { recursive: true });
    renameSync(worktreePath, orphanPath);
    return orphanPath;
  } catch (error) {
    throw new WorktreeRequestError({
      code: "unknown",
      message: `The restored workspace directory still exists and could not be moved aside (${worktreePath} → ${orphanPath}): ${String(error)}`,
    });
  }
}

export function createWorkspaceRecoveryService(deps: {
  paseoHome: string;
  worktreesRoot?: string;
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  getProject: (projectId: string) => Promise<PersistedProjectRecord | null>;
  isDirectory: (path: string) => Promise<boolean>;
  unarchiveWorkspace: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  // Clear only the restored archive generation. Pins are retained: jj has no
  // external-CAS deletion primitive and another daemon may still need them.
  clearRecoveryPin?: (
    workspaceId: string,
    expectedPin: string,
    expected: PersistedWorkspaceRecord,
  ) => Promise<void>;
  reportOrphan?: (path: string) => void;
  reportRetainedPin?: (pin: string, error: unknown) => void;
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

    if (workspace.recoveryBookmark) assertRecoveryPin(workspace.recoveryBookmark);
    const project = await deps.getProject(workspace.projectId);
    if (!project) {
      return {
        kind: "unavailable",
        workspaceId,
        reason: "project_not_found",
        message: "The project for this archived workspace no longer exists.",
      };
    }

    let authority;
    try {
      authority = jjWorkspaceAuthority(workspace);
    } catch (error) {
      return unavailableWorkspace(workspaceId, String(error));
    }
    const backingRoot = workspace.worktreeRoot ?? workspace.cwd;
    const sourceRepoRoot =
      workspace.mainRepoRoot ?? resolveJjRepoIdentity(backingRoot)?.primaryRoot ?? project.rootPath;
    const backingPresent = await deps.isDirectory(backingRoot);
    if (backingPresent || existsSync(backingRoot))
      return resolveSurvivingRecovery(workspace, sourceRepoRoot);
    if (authority === "external")
      return unavailableWorkspace(
        workspaceId,
        "The external jj workspace directory no longer exists and cannot be recreated.",
      );
    if (authority === "managed") {
      if (
        !workspace.recoveryBookmark ||
        !(await deps.isDirectory(sourceRepoRoot)) ||
        detectVcsBackend(sourceRepoRoot) !== "jj"
      )
        return unavailableWorkspace(
          workspaceId,
          "The saved jj source or recovery pin is unavailable; refusing alternate recovery.",
        );
      return createRecoveryPlan({ action: "restore", workspace, sourceRepoRoot });
    }
    if (detectVcsBackend(sourceRepoRoot) === "jj")
      return unavailableWorkspace(
        workspaceId,
        "Unknown legacy jj workspace authority; refusing automatic recreation.",
      );
    if (workspace.kind !== "worktree")
      return unavailableWorkspace(
        workspaceId,
        "The archived workspace directory no longer exists and cannot be recreated.",
      );
    // COMPAT(worktreeRestoreMissingMainRepoRoot): records created before v0.1.110
    // lack placement ownership; remove the project-root fallback after 2027-01-17.
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

  async function resolveSurvivingRecovery(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
  ): Promise<UnavailableRecoveryState | RecoveryPlan> {
    const backingRoot = workspace.worktreeRoot ?? workspace.cwd;
    try {
      if (jjWorkspaceAuthority(workspace) === "managed") {
        const registered = await validateJjRestoreBacking({
          workspace,
          sourceRepoRoot,
          backingRoot,
        });
        if (!registered)
          return createRecoveryPlan({ action: "restore", workspace, sourceRepoRoot });
      }
      await validatePresentJjWorkspace(workspace);
      if (!(await deps.isDirectory(workspace.cwd)))
        return unavailableWorkspace(
          workspace.workspaceId,
          "The selected project directory is missing from the surviving backing checkout; refusing recreation.",
        );
    } catch (error) {
      return unavailableWorkspace(workspace.workspaceId, String(error));
    }
    return createRecoveryPlan({ action: "unarchive", workspace });
  }

  async function validateJjRestoreBacking(input: JjRestoreBackingInput): Promise<boolean> {
    const { workspace, sourceRepoRoot, backingRoot } = input;
    if (detectVcsBackend(sourceRepoRoot) !== "jj")
      throw new Error("Managed jj source repository is unavailable; refusing Git recovery");
    const registered = await jjWorkspaceRootRegistered(sourceRepoRoot, backingRoot);
    if (!existsSync(backingRoot)) return registered;
    if (!(await deps.isDirectory(backingRoot)))
      throw new Error("The surviving backing root is not a directory; refusing recreation");
    // Retained exact pins may reconstruct forgotten plain partial directories, never replacement checkouts.
    const plainPartial =
      !registered &&
      detectVcsBackend(backingRoot) === "none" &&
      Boolean(workspace.recoveryBookmark);
    if (plainPartial) return registered;
    assertJjWorkspaceIncarnation(
      backingRoot,
      workspace.jjWorkspaceId ?? workspace.recoveryBookmark,
    );
    const backingIdentity = resolveJjRepoIdentity(backingRoot);
    const sourceIdentity = resolveJjRepoIdentity(sourceRepoRoot);
    if (
      !backingIdentity ||
      !sourceIdentity ||
      backingIdentity.sharedStorePath !== sourceIdentity.sharedStorePath ||
      workspaceLifecycleKey(backingIdentity.workspaceRoot) !== workspaceLifecycleKey(backingRoot)
    )
      throw new Error("The surviving jj backing repository changed; refusing recreation");
    return registered;
  }

  async function inspect(workspaceId: string): Promise<WorkspaceRecoveryState> {
    const resolved = await resolveRecovery(workspaceId);
    return resolved.kind === "unavailable" ? resolved : resolved.state;
  }

  async function restore(
    workspaceId: string,
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }> {
    const record = await deps.getWorkspace(workspaceId);
    if (!record) throw new Error("This workspace is no longer known to the host.");
    const backingRoot = await recoveryBackingRoot(record);
    return withWorkspaceLifecycle(backingRoot, () =>
      restoreUnderLifecycle(workspaceId, backingRoot),
    );
  }

  async function recoveryBackingRoot(record: PersistedWorkspaceRecord): Promise<string> {
    if (record.worktreeRoot) return record.worktreeRoot;
    const ownership = await isPaseoOwnedWorktreeCwd(record.cwd, {
      paseoHome: deps.paseoHome,
      worktreesRoot: deps.worktreesRoot,
      knownGitCommonDir: null,
    });
    return (ownership.allowed ? ownership.worktreePath : record.cwd) ?? record.cwd;
  }

  async function restoreUnderLifecycle(
    workspaceId: string,
    lockedRoot: string,
  ): Promise<{ workspaceId: string; action: WorkspaceRecoveryAction }> {
    const resolved = await resolveRecovery(workspaceId);
    if (resolved.kind === "unavailable") {
      throw new Error(resolved.message);
    }

    const currentRoot = await recoveryBackingRoot(resolved.workspace);
    if (workspaceLifecycleKey(currentRoot) !== workspaceLifecycleKey(lockedRoot))
      throw new Error("Workspace placement changed during recovery; retry");
    if (resolved.kind === "restore") {
      await recreateArchivedWorktree(resolved.workspace, resolved.sourceRepoRoot);
    }
    if (jjWorkspaceAuthority(resolved.workspace) === "managed") {
      const checkpoint = await readJjCheckpoint(currentRoot, deps.paseoHome);
      if (checkpoint) {
        validateJjCheckpoint(checkpoint, currentRoot);
        if (
          checkpoint.operations.some(
            (operation) =>
              operation.status === "pending" || operation.status === "reconciliation_required",
          )
        )
          throw new JjCheckpointError(
            "An unresolved jj operation requires reconciliation before unarchive; saved heads remain retained.",
          );
      } else if (resolved.workspace.jjCheckpointRef)
        throw new JjCheckpointError(
          "The checkpoint required by this workspace is missing; unarchive refused.",
        );
    }
    await deps.unarchiveWorkspace(resolved.workspace);
    if (resolved.workspace.recoveryBookmark && deps.clearRecoveryPin) {
      try {
        await deps.clearRecoveryPin(
          resolved.workspace.workspaceId,
          resolved.workspace.recoveryBookmark,
          resolved.workspace,
        );
      } catch (error) {
        // The restore/unarchive already committed. Retaining its private pin
        // and registry reference is safe; a cleanup warning is not a failed restore.
        deps.reportRetainedPin?.(resolved.workspace.recoveryBookmark, error);
      }
    }
    return { workspaceId, action: resolved.kind };
  }

  async function recreateArchivedWorktree(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
  ): Promise<void> {
    if (jjWorkspaceAuthority(workspace) === "managed") {
      if (detectVcsBackend(sourceRepoRoot) !== "jj")
        throw new Error("Managed jj source changed; refusing Git recovery");
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
    if (!previousWorktreePath) {
      // COMPAT(worktreeRestoreMissingWorktreeRoot): records created before v0.1.110
      // lack durable backing placement; remove filesystem discovery after 2027-01-17.
      const ownership = await isPaseoOwnedWorktreeCwd(workspace.cwd, {
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
        knownGitCommonDir: null,
      });
      previousWorktreePath = ownership.allowed
        ? (ownership.worktreePath ?? workspace.cwd)
        : workspace.cwd;
    }

    let recreatedWorktreePath: string;
    try {
      const result = await createWorktree({
        cwd: sourceRepoRoot,
        worktreeSlug: basename(previousWorktreePath),
        source,
        runSetup: false,
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
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
  async function validateArchivedCheckpoint(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
    worktreePath: string,
    pin: string,
  ): Promise<void> {
    const checkpoint = await readJjArchiveCheckpoint(worktreePath, pin, deps.paseoHome);
    const reference = workspace.jjCheckpointRef;
    if (
      reference &&
      (!checkpoint ||
        reference.path !== jjArchiveCheckpointPath(worktreePath, pin, deps.paseoHome) ||
        checkpoint.generation !== reference.generation)
    )
      throw new JjCheckpointError(
        "The retained jj checkpoint is missing or differs from its archive reference; directory retained.",
      );
    if (!checkpoint) return;
    const source = resolveJjRepoIdentity(sourceRepoRoot);
    if (
      !source ||
      checkpoint.sharedStore !== workspaceLifecycleKey(source.sharedStorePath) ||
      checkpoint.incarnation !== (workspace.jjWorkspaceId ?? pin) ||
      !checkpoint.recoveryPins.includes(pin)
    )
      throw new JjCheckpointError(
        "The retained jj checkpoint does not authorize this incarnation or pin; directory retained.",
      );
    const pinned = await resolveJjPinnedRevision(sourceRepoRoot, pin);
    if (pinned !== checkpoint.selection.commitId)
      throw new JjCheckpointError(
        "The recovery pin changed since its checkpoint. Reconcile retained heads before restoration.",
      );
  }

  async function reapplyArchivedCheckpoint(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
    worktreePath: string,
    pin: string,
  ): Promise<void> {
    const sourceIdentity = resolveJjRepoIdentity(sourceRepoRoot);
    if (!sourceIdentity) throw new JjCheckpointError("The saved jj source is unavailable.");
    const restoredCheckpoint = await restoreJjCheckpoint({
      backingRoot: worktreePath,
      sharedStore: sourceIdentity.sharedStorePath,
      incarnation: workspace.jjWorkspaceId ?? pin,
      paseoHome: deps.paseoHome,
      recoveryPin: pin,
    });
    if (restoredCheckpoint) {
      await reapplyJjSelection(
        worktreePath,
        pin,
        (await readJjCheckpoint(worktreePath, deps.paseoHome)) ?? restoredCheckpoint,
      );
    } else if (workspace.baseBranch) {
      // Legacy exact-pin recovery keeps its existing compatibility contract.
      try {
        const pinnedBase = await resolveJjPinnedRevision(sourceRepoRoot, workspace.baseBranch);
        writePaseoWorktreeMetadata(worktreePath, {
          baseRefName: workspace.baseBranch,
          baseRef: pinnedBase,
          ...(workspace.branch ? { jjBookmark: workspace.branch } : {}),
        });
      } catch {
        // Legacy records predate durable comparison state; retain exact-pin recovery.
      }
    }
  }

  async function reapplyJjSelection(
    worktreePath: string,
    pin: string,
    checkpoint: JjCheckpoint,
  ): Promise<void> {
    const context = { paseoHome: deps.paseoHome, worktreesRoot: deps.worktreesRoot };
    const before = await getJjChangeMeta(worktreePath, "@", context);
    if (!before)
      throw new JjCheckpointError(
        "Cannot capture the restoration working copy; no saved change was edited.",
      );
    const operation: JjCheckpointOperation = {
      id: randomUUID(),
      kind: "restore",
      before,
      target: checkpoint.selection,
      beforeOperation: await getJjOperationId(worktreePath, context),
      recoveryPin: pin,
      affectedHeads: [],
      status: "pending",
      after: null,
      afterOperation: null,
      error: null,
    };
    checkpoint = await writeJjCheckpoint(
      { ...checkpoint, operations: [...checkpoint.operations, operation] },
      deps.paseoHome,
    );
    try {
      // Reapply the exact retained native selection, not a copy or a moving base.
      const edited = await runJjCommand(["edit", pin], { cwd: worktreePath });
      if (edited.exitCode !== 0)
        throw new JjCheckpointError(
          `The saved change could not be edited during recovery: ${edited.stderr.trim()}. Pins remain retained.`,
        );
      const after = await getJjChangeMeta(worktreePath, "@", context);
      if (
        !after ||
        after.changeId !== checkpoint.selection.changeId ||
        after.commitId !== checkpoint.selection.commitId
      )
        throw new JjCheckpointError(
          "Restoration did not reapply the exact saved native change. Retained pins require reconciliation.",
        );
      validateJjCheckpoint(checkpoint, worktreePath);
      operation.status = "completed";
      operation.after = after;
      operation.afterOperation = await getJjOperationId(worktreePath, context);
      await writeJjCheckpoint(
        { ...checkpoint, operations: [...checkpoint.operations.slice(0, -1), operation] },
        deps.paseoHome,
      );
    } catch (error) {
      operation.status = "reconciliation_required";
      operation.error = error instanceof Error ? error.message : String(error);
      try {
        operation.after = await getJjChangeMeta(worktreePath, "@", context);
        operation.afterOperation = await getJjOperationId(worktreePath, context);
      } catch {
        /* Unknown state remains blocked, never undo. */
      }
      await writeJjCheckpoint(
        { ...checkpoint, operations: [...checkpoint.operations.slice(0, -1), operation] },
        deps.paseoHome,
      );
      throw error;
    }
  }

  async function recreateArchivedJjWorkspace(
    workspace: PersistedWorkspaceRecord,
    sourceRepoRoot: string,
  ): Promise<void> {
    const pin = workspace.recoveryBookmark;
    if (pin) assertRecoveryPin(pin);
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
    await validateArchivedCheckpoint(workspace, sourceRepoRoot, worktreePath, pin);
    // Recheck immediately before renaming too: external jj is not excluded by
    // the daemon lifecycle guard, and a registered live root is never an orphan.
    if (await validateJjRestoreBacking({ workspace, sourceRepoRoot, backingRoot: worktreePath })) {
      throw new WorktreeRequestError({
        code: "unknown",
        message:
          "The backing jj workspace is already registered; retry recovery without moving its live directory",
      });
    }
    // A surviving nonempty directory blocks `jj workspace add`. Move it aside
    // (never delete — it may hold files the pin does not cover); the orphan
    // name records what happened for manual inspection.
    const orphanPath = await quarantineSurvivingDirectory(worktreePath);
    if (orphanPath) deps.reportOrphan?.(orphanPath);
    try {
      await restoreJjWorkspace({
        cwd: sourceRepoRoot,
        worktreePath,
        workspaceName: basename(worktreePath),
        revision: pin,
      });
      // Legacy pins become the shared incarnation only after recreation from that exact pin.
      writeJjWorkspaceIncarnation(worktreePath, workspace.jjWorkspaceId ?? pin);
    } catch (error) {
      throw toWorktreeRequestError(error);
    }

    await reapplyArchivedCheckpoint(workspace, sourceRepoRoot, worktreePath, pin);

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

function unavailableWorkspace(workspaceId: string, message: string): UnavailableRecoveryState {
  return { kind: "unavailable", workspaceId, reason: "workspace_directory_missing", message };
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
