import {
  establishFreshJjAuthority,
  validatePresentJjWorkspace,
  jjWorkspaceAuthority,
} from "../../workspace-jj-authority.js";
import {
  withWorkspaceLifecycle,
  workspaceLifecycleKey,
} from "../../../utils/workspace-lifecycle.js";
import { resolveJjRepoIdentity, detectVcsBackend } from "../../../utils/vcs-backend.js";
import { readJjWorkspaceIncarnation } from "../../../utils/worktree-metadata.js";
import type { PluginLifecycle } from "../../plugins/lifecycle/index.js";
import { describeHookWorkspace } from "../../plugins/lifecycle/index.js";
import { basename, resolve } from "node:path";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import {
  generateWorkspaceId,
  initialWorkspacePlacement,
  reconcileWorkspacePlacement,
  type MutableWorkspacePlacement,
} from "../../workspace-registry-model.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { deriveProjectKey } from "../../project-key.js";
import { areEquivalentPaths, createRealpathAwarePathMatcher } from "../../../utils/path.js";
import type { UntrustedWorkspaceSource } from "../../workspace-automation-gate.js";

export interface ResolveOrCreateWorkspaceIdInput {
  createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  requestedWorkspaceId?: string;
  cwd: string;
  initialTitle: string | null;
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface ImportWorkspaceInput {
  cwd: string;
  requestedWorkspaceId?: string;
}

export interface ImportWorkspaceResult<T> {
  value: T;
  createdWorkspace: PersistedWorkspaceRecord | null;
}

export interface CreateWorktreeWorkspaceInput {
  sourceCwd: string;
  projectId?: string;
  workspaceId?: string;
  repoRoot: string;
  cwd: string;
  worktreeRoot: string;
  branch: string | null;
  baseBranch: string | null;
  title: string | null;
  expectsInitialAgent?: boolean;
  untrustedSource?: UntrustedWorkspaceSource;
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface WorkspaceProvisioningService {
  runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>>;
  findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord>;
  resolveOrCreateWorkspaceIdForCreateAgent(input: ResolveOrCreateWorkspaceIdInput): Promise<string>;
  createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: {
      expectsInitialAgent?: boolean;
      workspaceId?: string;
      background?: boolean;
      callerWorkspaceId?: string;
    },
  ): Promise<PersistedWorkspaceRecord>;
  createWorkspaceForWorktree(
    input: CreateWorktreeWorkspaceInput,
  ): Promise<PersistedWorkspaceRecord>;
  findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord>;
  ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord>;
}

export type WorkspaceProvisioningErrorCode = "unknown_project" | "archived_project";

export class WorkspaceProvisioningError extends Error {
  constructor(
    readonly code: WorkspaceProvisioningErrorCode,
    projectId: string,
  ) {
    super(
      code === "unknown_project"
        ? `Unknown project: ${projectId}`
        : `Archived project: ${projectId}`,
    );
    this.name = "WorkspaceProvisioningError";
  }
}

type ProvisioningWorkspaceFields = Partial<MutableWorkspacePlacement> &
  Partial<
    Pick<PersistedWorkspaceRecord, "archivedAt" | "autoArchivedChangeRequestUrl" | "updatedAt">
  >;

interface CheckoutRootObservation {
  backingKey: string;
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
}

interface WorkspaceCheckoutObservation {
  workspace: PersistedWorkspaceRecord;
  checkout: ProjectCheckoutLitePayload;
  backingKey: string;
}

interface WorkspaceFieldUpdate {
  workspace: PersistedWorkspaceRecord;
  fields: ProvisioningWorkspaceFields;
  backingKey: string;
}

function workspaceBackingRoot(workspace: PersistedWorkspaceRecord): string {
  // COMPAT(provisioningMissingWorktreeRoot): pre-v0.1.110 records lack backing placement; remove after 2027-01-17.
  return (
    workspace.worktreeRoot ?? resolveJjRepoIdentity(workspace.cwd)?.workspaceRoot ?? workspace.cwd
  );
}

function assertWorkspaceAuthority(
  planned: PersistedWorkspaceRecord,
  current: PersistedWorkspaceRecord,
): void {
  const sameRoot =
    workspaceLifecycleKey(workspaceBackingRoot(planned)) ===
    workspaceLifecycleKey(workspaceBackingRoot(current));
  const samePlacement =
    sameRoot &&
    areEquivalentPaths(planned.cwd, current.cwd) &&
    planned.projectId === current.projectId &&
    planned.kind === current.kind &&
    planned.mainRepoRoot === current.mainRepoRoot;
  if (
    !samePlacement ||
    planned.jjWorkspaceId !== current.jjWorkspaceId ||
    planned.jjWorkspaceManagement !== current.jjWorkspaceManagement
  )
    throw new Error("Workspace placement or incarnation changed while provisioning; retry");
}

function assertCheckoutRoot(observation: CheckoutRootObservation): void {
  const { backingKey, cwd, checkout } = observation;
  const observedRoot = checkout.worktreeRoot ?? cwd;
  if (backingKey !== workspaceLifecycleKey(observedRoot))
    throw new Error("Checkout placement changed while provisioning; retry");
}

function assertWorkspaceCheckout(observation: WorkspaceCheckoutObservation): void {
  const { workspace, checkout, backingKey } = observation;
  const authority = jjWorkspaceAuthority(workspace);
  if (authority === "external" && checkout.isGit && checkout.isPaseoOwnedWorktree)
    throw new Error("External jj checkout observation contradicts managed ownership");
  const hasJjRecoveryAuthority = authority === "managed";
  if (hasJjRecoveryAuthority) assertCheckoutRoot({ backingKey, cwd: workspace.cwd, checkout });
  if (
    hasJjRecoveryAuthority &&
    (!checkout.isGit ||
      !checkout.isPaseoOwnedWorktree ||
      !checkout.mainRepoRoot ||
      workspaceLifecycleKey(checkout.mainRepoRoot) !==
        workspaceLifecycleKey(workspace.mainRepoRoot ?? workspace.cwd))
  )
    throw new Error("Managed jj checkout ownership changed during observation; retry");
}

export function createWorkspaceProvisioningService(deps: {
  serverId?: string;
  paseoHome?: string;
  worktreesRoot?: string;
  workspaceRegistry: WorkspaceRegistry;
  projectRegistry: ProjectRegistry;
  workspaceGitService: Pick<WorkspaceGitService, "getCheckout" | "getSnapshot" | "peekSnapshot">;
  isDirectory: (path: string) => Promise<boolean>;
  logger: Logger;
  lifecycle?: PluginLifecycle;
}): WorkspaceProvisioningService {
  const { serverId, workspaceRegistry, projectRegistry, workspaceGitService, logger } = deps;

  /**
   * Placement facts at a workspace directory, or null when there is nothing
   * there to read. A git read answers "not a checkout" for a plain directory
   * and for a directory that is gone, and only the first is evidence that a
   * worktree stopped being one. That answer therefore counts only while the
   * directory is there on both sides of the read, so a worktree removed or
   * unmounted while the read is in flight stays an absence.
   */
  async function observeWorkspaceCheckout(cwd: string): Promise<ProjectCheckoutLitePayload | null> {
    if (!(await deps.isDirectory(cwd))) return null;
    const checkout = await workspaceGitService.getCheckout(cwd);
    if (!checkout.isGit && !(await deps.isDirectory(cwd))) return null;
    return checkout;
  }

  async function withCurrentWorkspace<T>(
    planned: PersistedWorkspaceRecord,
    operation: (current: PersistedWorkspaceRecord, backingKey: string) => Promise<T>,
  ): Promise<T> {
    const backingRoot = workspaceBackingRoot(planned);
    const backingKey = workspaceLifecycleKey(backingRoot);
    return withWorkspaceLifecycle(backingRoot, async () => {
      const current = await workspaceRegistry.get(planned.workspaceId);
      if (!current) throw new Error(`Workspace not found: ${planned.workspaceId}`);
      assertWorkspaceAuthority(planned, current);
      if (workspaceLifecycleKey(workspaceBackingRoot(current)) !== backingKey)
        throw new Error("Workspace backing root changed during provisioning; retry");
      await validatePresentJjWorkspace(current);
      return operation(current, backingKey);
    });
  }

  async function rereadObservedWorkspace(
    workspace: PersistedWorkspaceRecord,
    backingKey: string,
  ): Promise<PersistedWorkspaceRecord> {
    const current = await workspaceRegistry.get(workspace.workspaceId);
    if (!current) throw new Error(`Workspace not found: ${workspace.workspaceId}`);
    assertWorkspaceAuthority(workspace, current);
    if (workspaceLifecycleKey(workspaceBackingRoot(current)) !== backingKey)
      throw new Error("Workspace backing root changed during provisioning; retry");
    if (
      current.archivedAt !== workspace.archivedAt ||
      current.recoveryBookmark !== workspace.recoveryBookmark
    )
      throw new Error("Workspace recovery authority changed while provisioning; retry");
    return current;
  }

  async function updateWorkspaceFields(
    input: WorkspaceFieldUpdate,
  ): Promise<PersistedWorkspaceRecord> {
    const { workspace, fields, backingKey } = input;
    const updated = await workspaceRegistry.update(workspace.workspaceId, (current) => {
      assertWorkspaceAuthority(workspace, current);
      if (workspaceLifecycleKey(workspaceBackingRoot(current)) !== backingKey)
        throw new Error("Workspace backing root changed during provisioning; retry");
      if (
        current.archivedAt !== workspace.archivedAt ||
        current.recoveryBookmark !== workspace.recoveryBookmark
      )
        throw new Error("Workspace recovery authority changed while provisioning; retry");
      return { ...current, ...fields };
    });
    if (!updated) throw new Error(`Workspace not found: ${workspace.workspaceId}`);
    return updated;
  }

  async function runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>> {
    if (input.requestedWorkspaceId) {
      const workspace = await workspaceRegistry.get(input.requestedWorkspaceId);
      if (!workspace || workspace.archivedAt) {
        throw new Error(`Workspace not found: ${input.requestedWorkspaceId}`);
      }
      const project = await projectRegistry.get(workspace.projectId);
      if (!project || project.archivedAt) {
        throw new Error(`Project not found: ${workspace.projectId}`);
      }
      if (!createRealpathAwarePathMatcher(workspace.cwd)(input.cwd)) {
        throw new Error(`Import cwd does not match workspace: ${workspace.workspaceId}`);
      }
      return {
        value: await operation(workspace),
        createdWorkspace: null,
      };
    }

    const [projectsBeforeImport, workspacesBeforeImport] = await Promise.all([
      projectRegistry.list(),
      workspaceRegistry.list(),
    ]);
    const workspace = await findOrCreateWorkspaceForDirectory(input.cwd);
    const createdWorkspace = workspacesBeforeImport.some(
      (candidate) => candidate.workspaceId === workspace.workspaceId,
    )
      ? null
      : workspace;
    const previousProject =
      projectsBeforeImport.find((project) => project.projectId === workspace.projectId) ?? null;

    try {
      return {
        value: await operation(workspace),
        createdWorkspace,
      };
    } catch (error) {
      if (createdWorkspace) {
        await rollbackFailedImportWorkspace(createdWorkspace, previousProject);
      }
      throw error;
    }
  }

  async function rollbackFailedImportWorkspace(
    workspace: PersistedWorkspaceRecord,
    previousProject: PersistedProjectRecord | null,
  ): Promise<void> {
    try {
      await workspaceRegistry.remove(workspace.workspaceId);
      const projectHasActiveWorkspace = (await workspaceRegistry.list()).some(
        (candidate) => candidate.projectId === workspace.projectId && !candidate.archivedAt,
      );
      if (projectHasActiveWorkspace) {
        return;
      }
      if (previousProject?.archivedAt) {
        await projectRegistry.upsert(previousProject);
      } else if (!previousProject) {
        await projectRegistry.remove(workspace.projectId);
      }
    } catch (error) {
      logger.error(
        { err: error, workspaceId: workspace.workspaceId, projectId: workspace.projectId },
        "Failed to restore workspace state after provider import failure",
      );
    }
  }

  async function findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord> {
    const rootPath = resolve(cwd);
    const checkout = await workspaceGitService.getCheckout(rootPath);
    const timestamp = new Date().toISOString();
    return projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: checkout.isGit ? "git" : "non_git",
      displayName: basename(rootPath) || rootPath,
      projectKey: deriveProjectKey({
        rootPath,
        remoteUrl: checkout.remoteUrl,
        worktreeRoot: checkout.worktreeRoot,
        mainRepoRoot: checkout.mainRepoRoot,
        serverId,
      }),
      timestamp,
    });
  }

  async function requireActiveProject(projectId: string): Promise<PersistedProjectRecord> {
    const project = await projectRegistry.get(projectId);
    if (!project) throw new WorkspaceProvisioningError("unknown_project", projectId);
    if (project.archivedAt) throw new WorkspaceProvisioningError("archived_project", projectId);
    return project;
  }

  async function resolveBackground(input?: {
    background?: boolean;
    callerWorkspaceId?: string;
  }): Promise<boolean> {
    if (input?.background !== undefined) return input.background;
    if (!input?.callerWorkspaceId) return false;
    const callerWorkspace = await workspaceRegistry.get(input.callerWorkspaceId);
    if (!callerWorkspace) throw new Error(`Caller workspace ${input.callerWorkspaceId} not found`);
    return callerWorkspace.background;
  }

  async function createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: {
      expectsInitialAgent?: boolean;
      workspaceId?: string;
      background?: boolean;
      callerWorkspaceId?: string;
    },
  ): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    const plannedBackend = detectVcsBackend(normalizedCwd);
    const plannedJjRoot = resolveJjRepoIdentity(normalizedCwd)?.workspaceRoot;
    const plannedIncarnation = readJjWorkspaceIncarnation(plannedJjRoot ?? normalizedCwd);
    const plannedCheckout = await workspaceGitService.getCheckout(normalizedCwd);
    const backingRoot = plannedJjRoot ?? plannedCheckout.worktreeRoot ?? normalizedCwd;
    const backingKey = workspaceLifecycleKey(backingRoot);
    return withWorkspaceLifecycle(backingRoot, async () => {
      if (context?.workspaceId && (await workspaceRegistry.get(context.workspaceId)))
        throw new Error(`Record already exists: ${context.workspaceId}`);
      if (
        detectVcsBackend(normalizedCwd) !== plannedBackend ||
        readJjWorkspaceIncarnation(backingRoot) !== plannedIncarnation
      )
        throw new Error("Directory backend or incarnation changed during provisioning; retry");
      const checkout = await workspaceGitService.getCheckout(normalizedCwd);
      assertCheckoutRoot({ backingKey, cwd: normalizedCwd, checkout });
      const project = projectId
        ? await refreshProjectKind(await requireActiveProject(projectId), normalizedCwd, checkout)
        : // COMPAT(workspaceCreateMissingProjectId): added in v0.1.107, remove after 2027-01-15.
          await findOrCreateProjectForDirectory(normalizedCwd);
      const timestamp = new Date().toISOString();
      const initialWorkspace = createPersistedWorkspaceRecord({
        workspaceId: context?.workspaceId ?? generateWorkspaceId(),
        projectId: project.projectId,
        ...initialWorkspacePlacement({ source: "checkout", cwd: normalizedCwd, checkout }),
        title: title?.trim() || null,
        createdAt: timestamp,
        updatedAt: timestamp,
        background: await resolveBackground(context),
      });
      const workspace = await establishFreshJjAuthority({
        workspace: initialWorkspace,
        siblings: await workspaceRegistry.list(),
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
        createdWorktree: false,
      });
      await workspaceRegistry.upsert(workspace, {
        expectsInitialAgent: context?.expectsInitialAgent,
        requireAbsent: true,
      });
      emitWorkspaceCreated(workspace);
      return workspace;
    });
  }

  async function createWorkspaceForWorktree(
    input: CreateWorktreeWorkspaceInput,
  ): Promise<PersistedWorkspaceRecord> {
    const sourceCwd = resolve(input.sourceCwd);
    const repoRoot = resolve(input.repoRoot);
    const cwd = resolve(input.cwd);
    const worktreeRoot = resolve(input.worktreeRoot);
    const plannedBackend = detectVcsBackend(worktreeRoot);
    const plannedIncarnation = readJjWorkspaceIncarnation(worktreeRoot);
    return withWorkspaceLifecycle(worktreeRoot, async () => {
      if (
        detectVcsBackend(worktreeRoot) !== plannedBackend ||
        readJjWorkspaceIncarnation(worktreeRoot) !== plannedIncarnation
      )
        throw new Error("Worktree backend or incarnation changed during provisioning; retry");
      const project = await resolveSourceProjectForWorktree({
        sourceCwd,
        projectId: input.projectId,
        repoRoot,
      });
      const timestamp = new Date().toISOString();
      const initialWorkspace = createPersistedWorkspaceRecord({
        workspaceId: input.workspaceId ?? generateWorkspaceId(),
        projectId: project.projectId,
        ...initialWorkspacePlacement({
          source: "created_worktree",
          cwd,
          worktreeRoot,
          branch: input.branch,
          baseBranch: input.baseBranch,
          mainRepoRoot: repoRoot,
        }),
        title: input.title,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.untrustedSource ? { untrustedSource: input.untrustedSource } : {}),
        background: await resolveBackground(input),
      });
      const workspace = await establishFreshJjAuthority({
        workspace: initialWorkspace,
        siblings: await workspaceRegistry.list(),
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
        createdWorktree: true,
      });
      await workspaceRegistry.upsert(workspace, {
        expectsInitialAgent: input.expectsInitialAgent,
        requireAbsent: true,
      });
      emitWorkspaceCreated(workspace);
      return workspace;
    });
  }

  function emitWorkspaceCreated(workspace: PersistedWorkspaceRecord): void {
    deps.lifecycle?.emit("workspace.created", { workspace: describeHookWorkspace(workspace) });
  }

  async function resolveSourceProjectForWorktree(input: {
    sourceCwd: string;
    projectId?: string;
    repoRoot: string;
  }): Promise<PersistedProjectRecord> {
    if (input.projectId) {
      return refreshProjectKind(await requireActiveProject(input.projectId));
    }

    const workspaces = await workspaceRegistry.list();
    const sourceWorkspace =
      workspaces.find(
        (workspace) => !workspace.archivedAt && areEquivalentPaths(workspace.cwd, input.sourceCwd),
      ) ??
      workspaces.find(
        (workspace) => !workspace.archivedAt && areEquivalentPaths(workspace.cwd, input.repoRoot),
      );
    if (sourceWorkspace) {
      const project = await projectRegistry.get(sourceWorkspace.projectId);
      if (project) return refreshProjectKind(project);
      // COMPAT(worktreeMissingSourceProject): added in v0.1.107, remove after 2027-01-15.
      // Orphaned legacy workspace FKs fall through to exact-root allocation.
    }

    const checkout = await workspaceGitService.getCheckout(input.repoRoot);
    const project = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: input.repoRoot,
      kind: "git",
      displayName: basename(input.repoRoot) || input.repoRoot,
      projectKey: deriveProjectKey({
        rootPath: input.repoRoot,
        remoteUrl: checkout.remoteUrl,
        worktreeRoot: checkout.worktreeRoot,
        mainRepoRoot: checkout.mainRepoRoot,
        serverId,
      }),
      timestamp: new Date().toISOString(),
    });
    return refreshProjectKind(project);
  }

  async function publicDirectoryWorkspaces(cwd: string): Promise<PersistedWorkspaceRecord[]> {
    return (await workspaceRegistry.list())
      .filter((workspace) => !workspace.background && areEquivalentPaths(workspace.cwd, cwd))
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.workspaceId.localeCompare(right.workspaceId),
      );
  }

  async function findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    const plannedRecords = await publicDirectoryWorkspaces(normalizedCwd);
    const planned = plannedRecords.find((workspace) => !workspace.archivedAt) ?? plannedRecords[0];
    const plannedRoot =
      planned?.worktreeRoot ?? resolveJjRepoIdentity(normalizedCwd)?.workspaceRoot;
    const backingRoot =
      plannedRoot ??
      (await workspaceGitService.getCheckout(normalizedCwd)).worktreeRoot ??
      normalizedCwd;
    const backingKey = workspaceLifecycleKey(backingRoot);
    return withWorkspaceLifecycle(backingRoot, async () => {
      // A discovered record is reread by id after acquisition, never resurrected from its snapshot.
      const current = planned ? await workspaceRegistry.get(planned.workspaceId) : null;
      if (planned && !current)
        throw new Error("Workspace disappeared during directory discovery; retry");
      if (planned && current) assertWorkspaceAuthority(planned, current);
      const workspaces = current ? [current] : await publicDirectoryWorkspaces(normalizedCwd);
      const active = workspaces.find((workspace) => !workspace.archivedAt);
      const archived = workspaces.find((workspace) => workspace.archivedAt);
      const selected = active ?? archived;
      if (selected && workspaceLifecycleKey(workspaceBackingRoot(selected)) !== backingKey)
        throw new Error("Workspace placement changed during directory discovery; retry");
      if (active) return refreshWorkspaceRecord(active);
      if (archived) {
        const project = await projectRegistry.get(archived.projectId);
        if (project && !project.archivedAt) return ensureWorkspaceRecordUnarchived(archived);
      }
      const checkout = await workspaceGitService.getCheckout(normalizedCwd);
      assertCheckoutRoot({ backingKey, cwd: normalizedCwd, checkout });
      return createWorkspaceForDirectory(normalizedCwd);
    });
  }

  async function resolveOrCreateWorkspaceIdForCreateAgent(
    input: ResolveOrCreateWorkspaceIdInput,
  ): Promise<string> {
    if (input.createdWorktree) return input.createdWorktree.workspace.workspaceId;
    if (input.requestedWorkspaceId) return input.requestedWorkspaceId;
    return (
      await createWorkspaceForDirectory(input.cwd, input.initialTitle, undefined, {
        expectsInitialAgent: true,
        background: input.background,
        callerWorkspaceId: input.callerWorkspaceId,
      })
    ).workspaceId;
  }

  async function resolveRestoredAutoArchiveChangeRequestUrl(
    workspace: PersistedWorkspaceRecord,
  ): Promise<string | null> {
    if (!workspace.archivedAt) {
      return workspace.autoArchivedChangeRequestUrl;
    }
    const snapshot = await workspaceGitService.getSnapshot(workspace.cwd, {
      force: true,
      includeForge: true,
      reason: "workspace-restore-auto-archive-latch",
    });
    return snapshot.forge.pullRequest?.isMerged
      ? snapshot.forge.pullRequest.url
      : workspace.autoArchivedChangeRequestUrl;
  }

  async function ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    return withCurrentWorkspace(workspace, unarchiveWorkspaceUnderLifecycle);
  }

  async function unarchiveWorkspaceUnderLifecycle(
    workspace: PersistedWorkspaceRecord,
    backingKey: string,
  ): Promise<PersistedWorkspaceRecord> {
    const project = await projectRegistry.get(workspace.projectId);
    if (!project) throw new Error(`Unknown project: ${workspace.projectId}`);
    const timestamp = new Date().toISOString();
    const checkout =
      workspace.archivedAt || project.archivedAt
        ? await observeWorkspaceCheckout(workspace.cwd)
        : null;
    const autoArchivedChangeRequestUrl =
      await resolveRestoredAutoArchiveChangeRequestUrl(workspace);
    let fields: ProvisioningWorkspaceFields | null = null;
    if (checkout) {
      assertWorkspaceCheckout({ workspace, checkout, backingKey });
      await validatePresentJjWorkspace(workspace);
    }
    if (workspace.archivedAt) {
      const placementUpdate = reconcileWorkspacePlacement({
        workspace,
        checkout,
        updatedAt: timestamp,
      });
      fields = {
        ...placementUpdate?.fields,
        archivedAt: null,
        autoArchivedChangeRequestUrl,
        updatedAt: timestamp,
      };
    }
    if (project.archivedAt || workspace.archivedAt) {
      const projectCheckout =
        checkout && areEquivalentPaths(project.rootPath, workspace.cwd)
          ? checkout
          : await workspaceGitService.getCheckout(project.rootPath);
      const kind = projectCheckout.isGit ? "git" : "non_git";
      const projectKey = deriveProjectKey({
        rootPath: project.rootPath,
        remoteUrl: projectCheckout.remoteUrl,
        worktreeRoot: projectCheckout.worktreeRoot,
        mainRepoRoot: projectCheckout.mainRepoRoot,
        serverId,
      });
      if (project.archivedAt || project.kind !== kind || project.projectKey !== projectKey) {
        await projectRegistry.update(project.projectId, (current) => ({
          ...current,
          kind,
          projectKey,
          archivedAt: null,
          updatedAt: timestamp,
        }));
      }
    }
    if (!fields) return rereadObservedWorkspace(workspace, backingKey);
    return updateWorkspaceFields({ workspace, fields, backingKey });
  }

  async function refreshWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    return withCurrentWorkspace(workspace, async (current, backingKey) => {
      if (current.archivedAt)
        throw new Error("Workspace was archived before refresh; retry directory discovery");
      const checkout = await observeWorkspaceCheckout(current.cwd);
      if (checkout) {
        assertWorkspaceCheckout({ workspace: current, checkout, backingKey });
        await validatePresentJjWorkspace(current);
      }
      const project = await projectRegistry.get(current.projectId);
      if (project && !project.archivedAt)
        await refreshProjectKind(project, current.cwd, checkout ?? undefined);
      const updatedAt = new Date().toISOString();
      const update = reconcileWorkspacePlacement({ workspace: current, checkout, updatedAt });
      if (!update) return rereadObservedWorkspace(current, backingKey);
      return updateWorkspaceFields({
        workspace: current,
        fields: { ...update.fields, updatedAt },
        backingKey,
      });
    });
  }

  async function refreshProjectKind(
    project: PersistedProjectRecord,
    workspaceCwd?: string,
    workspaceCheckout?: Awaited<ReturnType<WorkspaceGitService["getCheckout"]>>,
  ): Promise<PersistedProjectRecord> {
    const projectCheckout =
      workspaceCwd && workspaceCheckout && areEquivalentPaths(project.rootPath, workspaceCwd)
        ? workspaceCheckout
        : await workspaceGitService.getCheckout(project.rootPath);
    const kind: PersistedProjectRecord["kind"] = projectCheckout.isGit ? "git" : "non_git";
    const projectKey = deriveProjectKey({
      rootPath: project.rootPath,
      remoteUrl: projectCheckout.remoteUrl,
      worktreeRoot: projectCheckout.worktreeRoot,
      mainRepoRoot: projectCheckout.mainRepoRoot,
      serverId,
    });
    if (project.kind === kind && project.projectKey === projectKey) return project;
    const updatedAt = new Date().toISOString();
    const refreshed = await projectRegistry.update(project.projectId, (current) => ({
      ...current,
      kind,
      projectKey,
      updatedAt,
    }));
    if (!refreshed) throw new Error(`Unknown project: ${project.projectId}`);
    return refreshed;
  }

  return {
    runInImportWorkspace,
    findOrCreateWorkspaceForDirectory,
    resolveOrCreateWorkspaceIdForCreateAgent,
    createWorkspaceForDirectory,
    createWorkspaceForWorktree,
    findOrCreateProjectForDirectory,
    ensureWorkspaceRecordUnarchived,
  };
}
