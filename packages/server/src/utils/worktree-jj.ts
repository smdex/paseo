import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { runJjCommand } from "./run-jj-command.js";
import { resolveJjRepoIdentity } from "./vcs-backend.js";
import { hasJjBookmark } from "./checkout-jj.js";
import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import {
  deriveShortAlphanumericHash,
  deriveWorktreeProjectHash,
  normalizePathForOwnership,
  removeDirectoryWithRetries,
  resolvePaseoWorktreesBaseRoot,
  resolveWorktreeCreatedAtIso,
  runWorktreeSetupCommands,
  runWorktreeTeardownCommands,
  seedPaseoConfigFile,
  writePaseoWorktreeMetadata,
  type CreatedWorktree,
  type PaseoWorktreeInfo,
  type WorktreeSource,
} from "./worktree.js";
import { getRealpathAwareRelativePath } from "./path.js";

/**
 * jj workspaces as Paseo worktrees (plan §6).
 *
 * A Paseo worktree on jj is `jj workspace add` under the same
 * `<worktrees-root>/<project-hash>/<slug>` layout git worktrees use, so the
 * path-shape ownership check (`isPaseoOwnedWorktreeCwd`) applies unchanged.
 * The workspace-owned feature bookmark follows the plan §2 ownership rules;
 * the base bookmark is recorded in metadata and never advanced.
 *
 * All jj calls go through the executor with its deterministic flags; workspace
 * commands tolerate the stale-working-copy state by running
 * `jj workspace update-stale` and retrying once.
 */

const STALE_WORKING_COPY_PATTERN = /working copy is stale/i;

const WORKSPACE_LIST_TEMPLATE =
  'name ++ "\\t" ++ root ++ "\\t" ++ target.commit_id() ++ "\\t" ++ target.change_id() ++ "\\t" ++ ' +
  'if(target.empty(), "empty", "nonempty") ++ "\\n"';

const COMMIT_ID_TEMPLATE = 'commit_id ++ "\\n"';

export interface JjWorktreeContext {
  paseoHome?: string;
  worktreesRoot?: string;
}

interface JjCommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runJj(args: string[], options: { cwd: string; acceptExitCodes?: number[] }) {
  return runJjCommand(args, options);
}

/**
 * Run a jj command in a workspace directory, recovering once from a stale
 * working copy (rewritten from another workspace; verified on 0.45.1: the
 * failing command prints "Error: The working copy is stale (not updated since
 * operation …)" and `jj workspace update-stale` resolves it).
 */
async function runJjWorkspaceSafe(
  args: string[],
  options: { cwd: string },
): Promise<JjCommandOutcome> {
  const first = await runJj(args, { cwd: options.cwd, acceptExitCodes: [0, 1, 2] });
  if (first.exitCode === 0) {
    return first;
  }
  if (!STALE_WORKING_COPY_PATTERN.test(first.stderr)) {
    throw new Error(`jj ${args[0]} failed in ${options.cwd}: ${first.stderr.trim()}`);
  }
  await runJj(["workspace", "update-stale"], { cwd: options.cwd });
  const second = await runJj(args, { cwd: options.cwd });
  return second;
}

/**
 * Project hash keyed by the SHARED jj identity (primary workspace root), so
 * every workspace of one repo clusters under the same worktrees root. Falls
 * back to the git derivation (colocated repos hash identically through the
 * common dir) and finally to the raw path.
 */
export async function deriveJjWorktreeProjectHash(cwd: string): Promise<string> {
  const identity = resolveJjRepoIdentity(cwd);
  if (identity?.primaryRoot) {
    return deriveShortAlphanumericHash(await normalizePathForOwnership(identity.primaryRoot));
  }
  try {
    return await deriveWorktreeProjectHash(cwd);
  } catch {
    return deriveShortAlphanumericHash(await normalizePathForOwnership(cwd));
  }
}

export async function getJjPaseoWorktreesRoot(
  cwd: string,
  context?: JjWorktreeContext,
): Promise<string> {
  const baseRoot = resolvePaseoWorktreesBaseRoot(context);
  return join(baseRoot, await deriveJjWorktreeProjectHash(cwd));
}

export type JjWorktreeSource = Extract<WorktreeSource, { kind: "branch-off" | "checkout-branch" }>;

function toJjWorktreeSource(source: WorktreeSource): JjWorktreeSource {
  if (source.kind === "branch-off" || source.kind === "checkout-branch") {
    return source;
  }
  // Change-request / PR checkout intents are deferred on jj (plan §7).
  throw new Error(`Worktree source "${source.kind}" is not supported on jj repositories yet`);
}

/**
 * Resolve a base revset to its STABLE commit id (never a symbolic ref), so
 * recorded base diffs stay meaningful as bookmarks move (plan §6 pinning).
 */
async function pinRevision(cwd: string, revset: string): Promise<string> {
  const result = await runJj(["log", "--no-graph", "-r", revset, "-T", COMMIT_ID_TEMPLATE], {
    cwd,
  });
  const commitId = result.stdout.trim().split("\n")[0];
  if (!commitId) {
    throw new Error(`Cannot resolve jj revision for base: ${revset}`);
  }
  return commitId;
}

export async function createJjWorktree(options: {
  cwd: string;
  worktreeSlug: string;
  source: WorktreeSource;
  runSetup?: boolean;
  paseoHome?: string;
  worktreesRoot?: string;
}): Promise<CreatedWorktree> {
  const source = toJjWorktreeSource(options.source);
  const slugValidation = validateBranchSlug(options.worktreeSlug);
  if (!slugValidation.valid) {
    throw new Error(`Invalid worktree name: ${slugValidation.error}`);
  }

  const primaryRoot = await normalizePathForOwnership(options.cwd);
  const worktreesRootPath = await getJjPaseoWorktreesRoot(options.cwd, options);
  let worktreePath = join(worktreesRootPath, options.worktreeSlug);
  mkdirSync(dirname(worktreePath), { recursive: true });
  let pathSuffix = 1;
  while (existsSync(worktreePath)) {
    worktreePath = `${join(worktreesRootPath, options.worktreeSlug)}-${pathSuffix}`;
    pathSuffix += 1;
  }
  // The jj workspace NAME must be unique; the suffixed directory basename is
  // exactly that, so path and name can never collide independently.
  const workspaceName = basename(worktreePath);

  // Base selection: branch-off cuts from the requested base (bookmark or
  // revset); checkout-branch continues at the existing bookmark. The base is
  // pinned to its commit id before anything is created so later bookmark
  // movement cannot shift the recorded comparison base.
  let baseRevset: string;
  let baseRefName: string;
  if (source.kind === "branch-off") {
    baseRevset = source.baseBranch;
    baseRefName = source.baseBranch;
  } else {
    if (!(await hasJjBookmark(primaryRoot, source.branchName))) {
      throw new Error(`Bookmark not found: ${source.branchName}`);
    }
    baseRevset = source.branchName;
    baseRefName = source.branchName;
  }
  const pinnedBase = await pinRevision(primaryRoot, baseRevset);

  // `jj workspace add` creates a new working-copy change on top of the base;
  // the destination directory is created by jj itself (verified on 0.45.1).
  await runJj(
    ["workspace", "add", worktreePath, "--name", workspaceName, "--revision", pinnedBase],
    { cwd: primaryRoot },
  );

  let branchName: string;
  try {
    if (source.kind === "branch-off") {
      // Workspace-owned FEATURE bookmark at the workspace head: the name the
      // caller asked for (or the slug when none). The base bookmark is never
      // created or advanced by this flow (plan §2/§6).
      const desired = source.branchName?.trim();
      const candidate = desired && desired.length > 0 ? desired : workspaceName;
      const branchValidation = validateBranchSlug(candidate);
      if (!branchValidation.valid) {
        throw new Error(`Invalid branch name: ${branchValidation.error}`);
      }
      if (await hasJjBookmark(primaryRoot, candidate)) {
        throw new Error(`Bookmark already exists: ${candidate}`);
      }
      // Created from the workspace so it lands on the workspace head (@ there).
      await runJjWorkspaceSafe(["bookmark", "create", candidate], { cwd: worktreePath });
      branchName = candidate;
    } else {
      // Checkout semantics: the workspace sits at the existing bookmark's head;
      // no new bookmark is created (mirrors `git worktree add <branch>`).
      branchName = source.branchName;
    }

    writePaseoWorktreeMetadata(worktreePath, {
      baseRefName,
      baseRef: pinnedBase,
      // Managed ownership (review fix 7): mutations advance exactly this
      // bookmark; derivation never substitutes for it.
      jjBookmark: branchName,
    });

    await seedPaseoConfigFile({ sourceCwd: primaryRoot, targetCwd: worktreePath });

    if (options.runSetup) {
      // cleanupOnFailure stays FALSE for jj: the git-only cleanup helper would
      // run `git worktree remove` and leave the jj workspace registered
      // (review fix 14) — the encompassing catch below rolls back jj-first.
      await runWorktreeSetupCommands({
        worktreePath,
        branchName,
        cleanupOnFailure: false,
      });
    }
  } catch (error) {
    await rollbackJjWorkspace(primaryRoot, workspaceName, worktreePath);
    throw error;
  }

  return {
    branchName,
    worktreePath: await normalizePathForOwnership(worktreePath),
    comparisonBaseRef: pinnedBase,
  };
}

export async function rollbackJjWorkspace(
  primaryRoot: string,
  name: string,
  worktreePath: string,
): Promise<void> {
  try {
    await runJj(["workspace", "forget", name], { cwd: primaryRoot, acceptExitCodes: [0, 1] });
    await removeDirectoryWithRetries(worktreePath);
  } catch {
    // Rollback is best-effort; the creation error is the reported one.
  }
}

export interface JjWorkspaceListEntry {
  name: string;
  root: string;
  commitId: string;
  changeId: string;
  empty: boolean;
}

function parseJjWorkspaceList(stdout: string): JjWorkspaceListEntry[] {
  const entries: JjWorkspaceListEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) {
      continue;
    }
    const [name, root, commitId, changeId, emptyFlag] = line.split("\t");
    if (
      !name ||
      !root ||
      !commitId ||
      !changeId ||
      (emptyFlag !== "empty" && emptyFlag !== "nonempty")
    ) {
      continue;
    }
    entries.push({ name, root, commitId, changeId, empty: emptyFlag === "empty" });
  }
  return entries;
}

export async function listJjWorkspaces(cwd: string): Promise<JjWorkspaceListEntry[]> {
  const result = await runJj(["workspace", "list", "-T", WORKSPACE_LIST_TEMPLATE], { cwd });
  return parseJjWorkspaceList(result.stdout);
}

/**
 * Paseo-owned jj workspaces under the project worktrees root. The primary
 * (default) workspace is skipped: it is the user's own checkout, not a Paseo
 * worktree, mirroring `git worktree list` filtering.
 */
export async function listJjPaseoWorktrees(options: {
  cwd: string;
  paseoHome?: string;
  worktreesRoot?: string;
}): Promise<PaseoWorktreeInfo[]> {
  const primaryRoot = await normalizePathForOwnership(options.cwd);
  const worktreesRootPath = await getJjPaseoWorktreesRoot(options.cwd, options);
  const entries = await listJjWorkspaces(primaryRoot);
  const paseoOwned: PaseoWorktreeInfo[] = [];
  for (const entry of entries) {
    if (entry.name === "default") {
      continue;
    }
    const path = await normalizePathForOwnership(entry.root);
    const relative = getRealpathAwareRelativePath(worktreesRootPath, path);
    if (relative === null || relative.length === 0) {
      continue;
    }
    paseoOwned.push({
      path,
      createdAt: await resolveWorktreeCreatedAtIso(path),
      head: entry.commitId,
    });
  }
  return paseoOwned;
}

export class PrimaryWorkspaceDeleteError extends Error {
  constructor(path: string) {
    super(`Refusing to forget the primary jj workspace: ${path}`);
    this.name = "PrimaryWorkspaceDeleteError";
  }
}

export interface DeleteJjPaseoWorktreeOptions {
  /** Primary repo root (or any directory of the shared repo). */
  cwd: string;
  worktreePath: string;
  worktreeSlug?: string;
  teardownCwds?: string[];
  worktreesRoot?: string;
  paseoHome?: string;
  worktreesBaseRoot?: string;
  /**
   * Stable pin identity (workspaceId preferred). Falls back to the workspace
   * name; a stable key keeps pins unique across same-name recreations
   * (review fix 3).
   */
  pinKey?: string;
  /**
   * Durable pin persistence (plan §6): called with the recovery bookmark name
   * BEFORE the workspace is forgotten; when provided and it fails, deletion
   * aborts with nothing removed.
   */
  persistRecoveryPin?: (pin: string) => Promise<void>;
}

/** Unsnapshotted workspace files would be lost by forget+remove (review fix 2). */
export class JjUnsnapshottedFilesError extends Error {
  constructor(readonly untrackedPaths: string[]) {
    super(
      `The jj workspace has ${untrackedPaths.length} file(s) jj refused to snapshot; archive them manually first`,
    );
    this.name = "JjUnsnapshottedFilesError";
  }
}

/**
 * Delete a Paseo-owned jj workspace with the recovery-pin sequence (plan §6):
 * pin the workspace head with a private bookmark, persist the pin durably, and
 * only then forget + remove. Never touches the primary workspace.
 */
export async function deleteJjPaseoWorktree(options: DeleteJjPaseoWorktreeOptions): Promise<void> {
  const primaryRoot = await normalizePathForOwnership(options.cwd);
  const resolvedWorktree = await normalizePathForOwnership(options.worktreePath);

  const workspaces = await listJjWorkspaces(primaryRoot);
  let match = null;
  for (const entry of workspaces) {
    if (await normalizePathForOwnership(entry.root) === resolvedWorktree) { match = entry; break; }
  }
  if (match?.name === "default") {
    // Guard BEFORE anything else: jj itself only warns when forgetting the
    // current workspace (verified on 0.45.1), so Paseo must refuse.
    throw new PrimaryWorkspaceDeleteError(resolvedWorktree);
  }

  const worktreesRootPath = await getJjPaseoWorktreesRoot(primaryRoot, {
    paseoHome: options.paseoHome,
    worktreesRoot: options.worktreesRoot ?? options.worktreesBaseRoot,
  });
  const relativeWorktree = getRealpathAwareRelativePath(worktreesRootPath, resolvedWorktree);
  if (relativeWorktree === null || relativeWorktree === "") {
    throw new Error("Refusing to delete non-Paseo worktree");
  }

  if (!match) {
    // Already forgotten (e.g. a prior partial deletion): just remove the directory.
    await removeDirectoryWithRetries(resolvedWorktree);
    return;
  }

  // Snapshot the workspace FIRST from inside it (review fix 2): reading
  // `<name>@` from the primary does NOT snapshot the secondary's files, so
  // unsnapshotted edits would be lost by forget+remove. The stale-safe run
  // also recovers a stale working copy.
  const snapshot = await runJjWorkspaceSafe(["status"], { cwd: resolvedWorktree });
  const untrackedPaths = parseUntrackedPaths(snapshot.stdout);
  if (untrackedPaths.length > 0) {
    throw new JjUnsnapshottedFilesError(untrackedPaths);
  }
  const headCommitId = await resolveWorkspaceHead(primaryRoot, match.name, resolvedWorktree);

  // 1. Recovery pin: private bookmark at the workspace head, STRICT (review
  //    fix 3): any creation failure aborts with nothing removed; an existing
  //    pin is moved to the captured head with a guarded --from and verified.
  //    `paseo/…` bookmarks are never push targets.
  const pin = recoveryPinName(options.pinKey ?? match.name);
  const pinTarget = await readBookmarkTarget(primaryRoot, pin);
  if (pinTarget === null) {
    await runJj(["bookmark", "create", pin, "--revision", headCommitId], { cwd: primaryRoot });
  } else if (pinTarget !== headCommitId) {
    await runJj(
      ["bookmark", "move", "--allow-backwards", pin, "--from", pinTarget, "--to", headCommitId],
      { cwd: primaryRoot },
    );
  }
  const pinnedAt = await readBookmarkTarget(primaryRoot, pin);
  if (pinnedAt !== headCommitId) {
    throw new Error(`Recovery pin ${pin} did not land on the workspace head; aborting deletion`);
  }

  // 2. Durable persistence BEFORE forgetting. An empty workspace's change
  //    becomes unreachable after forget, so the pin bookmark is the only
  //    recoverable handle (round-3 review fix).
  if (options.persistRecoveryPin) {
    await options.persistRecoveryPin(pin);
  }
  // 3. Teardown + forget + remove.
  for (const teardownCwd of options.teardownCwds ?? [resolvedWorktree]) {
    // Repo-configured teardown commands are VCS-agnostic (paseo.json driven).
    await runWorktreeTeardownCommands({ worktreePath: resolvedWorktree, teardownCwd });
  }
  await runJj(["workspace", "forget", match.name], { cwd: primaryRoot });
  await removeDirectoryWithRetries(resolvedWorktree);
}

async function resolveWorkspaceHead(
  primaryRoot: string,
  workspaceName: string,
  workspacePath: string,
): Promise<string> {
  // The `<name>@` revset read from the primary is the cheap path; fall back to
  // the workspace-side @ (with stale refresh) when the revset is unavailable.
  const primary = await runJj(
    ["log", "--no-graph", "-r", `${workspaceName}@`, "-T", COMMIT_ID_TEMPLATE],
    { cwd: primaryRoot, acceptExitCodes: [0, 1] },
  );
  if (primary.exitCode === 0) {
    const commitId = primary.stdout.trim().split("\n")[0];
    if (commitId) {
      return commitId;
    }
  }
  const inWorkspace = await runJjWorkspaceSafe(
    ["log", "--no-graph", "-r", "@", "-T", COMMIT_ID_TEMPLATE],
    { cwd: workspacePath },
  );
  const commitId = inWorkspace.stdout.trim().split("\n")[0];
  if (!commitId) {
    throw new Error(`Cannot resolve jj workspace head for ${workspaceName}`);
  }
  return commitId;
}

export function recoveryPinName(workspaceName: string): string {
  return `paseo/recovery/${workspaceName}`;
}

/** The exact commit a local bookmark points at; null when it does not resolve. */
async function readBookmarkTarget(cwd: string, bookmark: string): Promise<string | null> {
  const result = await runJj(
    ["log", "--no-graph", "-r", `bookmarks(exact:"${bookmark}")`, "-T", COMMIT_ID_TEMPLATE],
    { cwd, acceptExitCodes: [0, 1] },
  );
  const commitId = result.stdout.trim().split("\n")[0];
  return commitId && result.exitCode === 0 ? commitId : null;
}

function parseUntrackedPaths(statusStdout: string): string[] {
  // jj reports refused snapshots under "Untracked paths:" (verified on
  // 0.45.1: files over snapshot.max-new-file-size land there).
  const marker = statusStdout.indexOf("Untracked paths:");
  if (marker === -1) {
    return [];
  }
  return statusStdout
    .slice(marker + "Untracked paths:".length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("(the "))
    .map((line) => line.replace(/^\.\.\//, ""));
}

/** Resolve a revset to its stable commit id (pinned-base helper for restores). */
export async function resolveJjPinnedRevision(cwd: string, revset: string): Promise<string> {
  const result = await runJj(["log", "--no-graph", "-r", revset, "-T", COMMIT_ID_TEMPLATE], {
    cwd,
  });
  const commitId = result.stdout.trim().split("\n")[0];
  if (!commitId) {
    throw new Error(`Cannot resolve jj revision: ${revset}`);
  }
  return commitId;
}

/** True when the revset (e.g. a recovery bookmark) resolves to a commit. */
export async function jjRevisionResolves(cwd: string, revset: string): Promise<boolean> {
  const result = await runJj(["log", "--no-graph", "-r", revset, "-T", COMMIT_ID_TEMPLATE], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

/**
 * Restore an archived jj workspace at its pinned revision: `jj workspace add`
 * on the recovery bookmark puts the pinned change back as the workspace's
 * parent (verified on 0.45.1: the new working-copy change is a child of the
 * pin, so no work is lost). No feature bookmark is created; the record's
 * branch name keeps its identity.
 */
export async function restoreJjWorkspace(options: {
  cwd: string;
  worktreePath: string;
  workspaceName: string;
  revision: string;
}): Promise<void> {
  await runJj(
    [
      "workspace",
      "add",
      options.worktreePath,
      "--name",
      options.workspaceName,
      "--revision",
      options.revision,
    ],
    { cwd: options.cwd },
  );
}

/** Remove a recovery bookmark after a successful restore. */
export async function deleteJjBookmark(cwd: string, name: string): Promise<void> {
  await runJj(["bookmark", "delete", name], { cwd, acceptExitCodes: [0, 1] });
}

export async function workspaceNameFromPath(worktreePath: string): Promise<string> {
  return basename(await normalizePathForOwnership(worktreePath));
}

export { runJjWorkspaceSafe };
