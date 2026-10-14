import { existsSync, mkdirSync, renameSync } from "node:fs";
import type { Logger } from "pino";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import type { ForgeRepositoryContext } from "../services/forge-service.js";
import { resolveSshHostname } from "./ssh-hostname.js";
import type { JjCheckpoint } from "./jj-checkpoint.js";
import {
  importJjCheckpoint,
  readJjCheckpoint,
  validateJjCheckpoint,
  writeJjCheckpoint,
  writeJjArchiveCheckpoint,
} from "./jj-checkpoint.js";
import { withWorkspaceLifecycle } from "./workspace-lifecycle.js";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { runJjCommand, withJjDeletionTransaction } from "./run-jj-command.js";
import { resolveJjRepoIdentity } from "./vcs-backend.js";
import {
  hasJjBookmark,
  getJjSnapshotFacts,
  getJjChangeMeta,
  getJjForgeRepositoryContext,
  isSafeJjRef,
  type JjRemoteInfo,
} from "./checkout-jj.js";
import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import {
  deriveShortAlphanumericHash,
  isPaseoOwnedWorktreeCwd,
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
import { readPaseoWorktreeMetadata, writeJjWorkspaceIncarnation } from "./worktree-metadata.js";

/**
 * jj workspaces as Paseo worktrees (plan §6).
 *
 * New jj workspaces are siblings of the source checkout. Their incarnation
 * and worktree metadata establish ownership independently of their location.
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

export type JjWorktreeSource = Extract<
  WorktreeSource,
  { kind: "branch-off" | "checkout-branch" | "checkout-change-request" }
>;

function toJjWorktreeSource(source: WorktreeSource): JjWorktreeSource {
  if (
    source.kind === "branch-off" ||
    source.kind === "checkout-branch" ||
    source.kind === "checkout-change-request"
  )
    return source;
  if (source.kind === "checkout-github-pr")
    return {
      ...source,
      kind: "checkout-change-request",
      forge: "github",
      changeRequestNumber: source.githubPrNumber,
    };
  throw new Error(`Worktree source "${source.kind}" is not supported on jj repositories`);
}

export class JjWorkspaceSourceError extends Error {
  readonly code = "workspace_source_unavailable";
  constructor(cause: unknown) {
    super(
      `Unable to open the selected pull request: ${cause instanceof Error ? cause.message : String(cause)}. Check the pull request and its remotes, then retry.`,
      { cause },
    );
    this.name = "JjWorkspaceSourceError";
  }
}

const remoteBookmarkRevset = (name: string, remote: string) =>
  `remote_bookmarks(exact:${JSON.stringify(name)}, exact:${JSON.stringify(remote)})`;

async function prepareJjPrSource(
  cwd: string,
  source: Extract<JjWorktreeSource, { kind: "checkout-change-request" }>,
  options: { forgeRepository?: ForgeRepositoryContext; paseoHome?: string },
): Promise<{
  head: string;
  base: string;
  liveBase: string;
  publication: Omit<NonNullable<JjCheckpoint["publication"]>, "localBookmark">;
}> {
  const repository = options.forgeRepository ?? (await getJjForgeRepositoryContext(cwd, options));
  const facts = await getJjSnapshotFacts(cwd, options);
  if (!facts.isJj) throw new Error("The jj source workspace is unavailable");
  const checkpoint = await readJjCheckpoint(facts.identity.workspaceRoot, options.paseoHome);
  if (checkpoint) validateJjCheckpoint(checkpoint, facts.identity.workspaceRoot);
  const selection = checkpoint?.publication ?? checkpoint?.forgeRemote;
  let selectedRemote = facts.remotes.length === 1 ? facts.remotes[0] : undefined;
  if (selection)
    selectedRemote = facts.remotes.find(
      (remote) => remote.name === selection.remoteName && remote.url === selection.remoteUrl,
    );
  if (!selectedRemote)
    throw new Error("Select an unambiguous jj forge remote before opening a pull request");
  const targetRemote = await resolveJjPrTargetRemote(facts.remotes, repository, selectedRemote);
  const headLocation = source.pushRemoteUrl ? parseGitRemoteLocation(source.pushRemoteUrl) : null;
  const sourceRepository =
    headLocation?.path.replace(/\.git$/, "") ??
    source.headRepository ??
    repository.targetRepository;
  let headRemote = targetRemote;
  if (sourceRepository !== repository.targetRepository) {
    headRemote = await resolveJjPrForkRemote({
      cwd,
      source,
      remotes: facts.remotes,
      selectedRemote,
      captureSourceRemote: !selection,
      paseoHome: options.paseoHome,
    });
  }
  const fetch = async (remote: string, branches: string[]) =>
    runJj(
      [
        "--ignore-working-copy",
        "--config",
        "git.abandon-unreachable-commits=false",
        "git",
        "fetch",
        "--remote",
        `exact:${remote}`,
        ...branches.flatMap((branch) => ["--branch", `exact:${branch}`]),
      ],
      { cwd },
    );
  if (headRemote.name === targetRemote.name)
    await fetch(targetRemote.name, [source.baseRefName, source.headRef]);
  else {
    await fetch(targetRemote.name, [source.baseRefName]);
    await fetch(headRemote.name, [source.headRef]);
  }
  const liveBase = remoteBookmarkRevset(source.baseRefName, targetRemote.name);
  return {
    head: await pinRevision(cwd, remoteBookmarkRevset(source.headRef, headRemote.name)),
    base: await pinRevision(cwd, liveBase),
    liveBase,
    publication: {
      remoteName: headRemote.name,
      remoteUrl: headRemote.url,
      remoteBookmark: source.headRef,
      sourceRepository,
      targetRepository: repository.targetRepository,
    },
  };
}

async function resolveJjPrTargetRemote(
  remotes: JjRemoteInfo[],
  repository: ForgeRepositoryContext,
  selectedRemote: JjRemoteInfo,
): Promise<JjRemoteInfo> {
  const matchingTargets: JjRemoteInfo[] = [];
  for (const remote of remotes) {
    const location = parseGitRemoteLocation(remote.url);
    if (!location || location.path.replace(/\.git$/, "") !== repository.targetRepository) continue;
    const host = ["ssh", "scp"].includes(location.transport)
      ? ((await resolveSshHostname(location.host)) ?? location.host)
      : location.host;
    if (host === repository.host) matchingTargets.push(remote);
  }
  let targetRemote = matchingTargets.length === 1 ? matchingTargets[0] : undefined;
  if (matchingTargets.length === 0 && repository.sourceRepository === repository.targetRepository)
    targetRemote = selectedRemote;
  if (!targetRemote)
    throw new Error(
      `Configure an unambiguous remote for target repository ${repository.targetRepository}`,
    );
  return targetRemote;
}

async function resolveJjPrForkRemote({
  cwd,
  source,
  remotes,
  selectedRemote,
  captureSourceRemote,
  paseoHome,
}: {
  cwd: string;
  source: Extract<JjWorktreeSource, { kind: "checkout-change-request" }>;
  remotes: JjRemoteInfo[];
  selectedRemote: JjRemoteInfo;
  captureSourceRemote: boolean;
  paseoHome?: string;
}): Promise<JjRemoteInfo> {
  if (!source.pushRemoteUrl) throw new Error("The pull request source repository is unavailable");
  const matches = remotes.filter((remote) => remote.url === source.pushRemoteUrl);
  if (matches.length > 1) throw new Error("The pull request source remote is ambiguous");
  if (matches[0]) return matches[0];
  // Adding a shared remote must not change the source workspace's forge identity,
  // including a bookmarkless source that cannot have a publication mapping.
  if (captureSourceRemote)
    await withWorkspaceLifecycle(cwd, async () => {
      const meta = await getJjChangeMeta(cwd, "@");
      if (!meta) throw new Error("The source jj change is unavailable");
      const captured = await importJjCheckpoint({
        backingRoot: cwd,
        head: { commitId: meta.commitId, changeId: meta.changeId },
        paseoHome,
      });
      if (captured.publication || captured.forgeRemote) return;
      await writeJjCheckpoint(
        {
          ...captured,
          forgeRemote: { remoteName: selectedRemote.name, remoteUrl: selectedRemote.url },
        },
        paseoHome,
      );
    });
  let name = `paseo-pr-${source.changeRequestNumber}`;
  for (let suffix = 1; remotes.some((remote) => remote.name === name); suffix++)
    name = `paseo-pr-${source.changeRequestNumber}-${suffix}`;
  await runJj(["git", "remote", "add", name, source.pushRemoteUrl], { cwd });
  // jj applies URL rewrites when listing remotes. Save the effective URL used
  // by forge reads/push validation rather than the adapter's raw SSH spelling.
  const updated = await getJjSnapshotFacts(cwd, { paseoHome });
  const added = updated.isJj ? updated.remotes.find((remote) => remote.name === name) : undefined;
  if (!added) throw new Error("The PR source remote disappeared during checkout");
  return added;
}

/**
 * Resolve a base revset to its STABLE commit id (never a symbolic ref), so
 * recorded base diffs stay meaningful as bookmarks move (plan §6 pinning).
 */
async function pinRevision(cwd: string, revset: string): Promise<string> {
  const result = await runJj(["log", "--no-graph", "-r", revset, "-T", COMMIT_ID_TEMPLATE], {
    cwd,
  });
  const ids = result.stdout.trim().split("\n");
  const commitId = ids[0];
  if (result.truncated || ids.length !== 1 || !/^[0-9a-f]{40,64}$/.test(commitId)) {
    throw new Error(`Cannot resolve jj revision for base: ${revset}`);
  }
  return commitId;
}

export class JjWorkspacePathExistsError extends Error {
  readonly code = "workspace_path_exists";

  constructor(path: string) {
    super(
      `Workspace path already exists: ${path}. Choose a different worktree name or remove the existing directory before retrying.`,
    );
    this.name = "JjWorkspacePathExistsError";
  }
}

export async function createJjWorktree(options: {
  cwd: string;
  worktreeSlug: string;
  source: WorktreeSource;
  forgeRepository?: ForgeRepositoryContext;
  runSetup?: boolean;
  onCreated?: (worktree: CreatedWorktree) => Promise<void>;
  logger?: Pick<Logger, "warn">;
  paseoHome?: string;
  worktreesRoot?: string;
}): Promise<CreatedWorktree> {
  const source = toJjWorktreeSource(options.source);
  const slugValidation = validateBranchSlug(options.worktreeSlug);
  if (!slugValidation.valid) {
    throw new Error(`Invalid worktree name: ${slugValidation.error}`);
  }

  const identity = resolveJjRepoIdentity(options.cwd);
  if (!identity) throw new Error("Unable to resolve jj repository identity");
  const primaryRoot = await normalizePathForOwnership(identity.workspaceRoot);
  const projectRoot = await normalizePathForOwnership(identity.primaryRoot);
  const worktreePath = join(
    dirname(primaryRoot),
    `${basename(projectRoot)}-${options.worktreeSlug}`,
  );
  const workspaceName = basename(worktreePath);

  return withWorkspaceLifecycle(worktreePath, async () => {
    const worktree = await createJjWorkspaceAtPath(
      options,
      source,
      primaryRoot,
      worktreePath,
      workspaceName,
    );
    // Provisioning/rollback must finish before a queued archive can inspect this path.
    await options.onCreated?.(worktree);
    return worktree;
  });
}

async function createJjWorkspaceAtPath(
  options: Parameters<typeof createJjWorktree>[0],
  source: JjWorktreeSource,
  primaryRoot: string,
  worktreePath: string,
  workspaceName: string,
): Promise<CreatedWorktree> {
  if (existsSync(worktreePath)) throw new JjWorkspacePathExistsError(worktreePath);
  // Base selection: branch-off cuts from the requested base (bookmark or
  // revset); checkout-branch continues at the existing bookmark. The base is
  // pinned to its commit id before anything is created so later bookmark
  // movement cannot shift the recorded comparison base.
  let baseRevset: string;
  let baseRefName: string;
  let prSource: Awaited<ReturnType<typeof prepareJjPrSource>> | undefined;
  if (source.kind === "checkout-change-request") {
    try {
      prSource = await prepareJjPrSource(primaryRoot, source, options);
    } catch (error) {
      throw new JjWorkspaceSourceError(error);
    }
    baseRevset = prSource.base;
    baseRefName = source.baseRefName;
  } else if (source.kind === "branch-off") {
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
    [
      "workspace",
      "add",
      worktreePath,
      "--name",
      workspaceName,
      "--revision",
      prSource?.head ?? pinnedBase,
    ],
    { cwd: primaryRoot },
  );

  let branchName: string;
  let createdBookmark: { name: string; target: string } | undefined;
  try {
    writeJjWorkspaceIncarnation(worktreePath, randomUUID());
    if (source.kind === "checkout-branch") branchName = source.branchName;
    else {
      createdBookmark = await createJjFeatureBookmark(
        primaryRoot,
        worktreePath,
        workspaceName,
        source,
        options.worktreeSlug,
        prSource?.publication,
      );
      branchName = createdBookmark.name;
    }

    writePaseoWorktreeMetadata(worktreePath, {
      baseRefName,
      baseRef: pinnedBase,
      // Managed ownership (review fix 7): mutations advance exactly this
      // bookmark; derivation never substitutes for it.
      jjBookmark: branchName,
      ...(source.kind === "checkout-change-request"
        ? {
            changeRequestLookupTarget: {
              headRef: source.headRef,
              changeRequestNumber: source.changeRequestNumber,
              localBranchName: branchName,
              ...(source.headRepositoryOwner
                ? { headRepositoryOwner: source.headRepositoryOwner }
                : {}),
            },
          }
        : {}),
    });

    if (prSource) {
      const meta = await getJjChangeMeta(worktreePath, "@");
      if (!meta) throw new Error("The PR workspace change is unavailable");
      const checkpoint = await importJjCheckpoint({
        backingRoot: worktreePath,
        head: { commitId: meta.commitId, changeId: meta.changeId },
        paseoHome: options.paseoHome,
      });
      await writeJjCheckpoint(
        {
          ...checkpoint,
          comparison: { ...checkpoint.comparison, liveBase: prSource.liveBase },
          publication: { ...prSource.publication, localBookmark: branchName },
        },
        options.paseoHome,
      );
    }

    await seedPaseoConfigFile({ sourceCwd: primaryRoot, targetCwd: worktreePath });

    if (options.runSetup) {
      // cleanupOnFailure stays FALSE for jj: the git-only cleanup helper would
      // run `git worktree remove` and leave the jj workspace registered
      // (review fix 14) — the encompassing catch below rolls back jj-first.
      await runWorktreeSetupCommands({
        worktreePath,
        branchName,
        repoRootPath: primaryRoot,
        cleanupOnFailure: false,
      });
    }
  } catch (error) {
    await rollbackJjWorkspace(primaryRoot, workspaceName, worktreePath, {
      createdBookmark,
      logger: options.logger,
    });
    throw error;
  }

  return {
    branchName,
    worktreePath: await normalizePathForOwnership(worktreePath),
    comparisonBaseRef: pinnedBase,
    ...(createdBookmark ? { jjCreatedBookmark: createdBookmark } : {}),
  };
}

async function createJjFeatureBookmark(
  sourceRoot: string,
  worktreePath: string,
  workspaceName: string,
  source: Extract<JjWorktreeSource, { kind: "branch-off" | "checkout-change-request" }>,
  slug: string,
  publication?: Omit<NonNullable<JjCheckpoint["publication"]>, "localBookmark">,
): Promise<{ name: string; target: string }> {
  const desired = source.kind === "branch-off" ? source.branchName?.trim() : slug;
  let candidate = desired && desired.length > 0 ? desired : workspaceName;
  const ownsPrHead =
    source.kind === "checkout-change-request" &&
    isSafeJjRef(source.headRef) &&
    !(await hasJjBookmark(sourceRoot, source.headRef));
  if (ownsPrHead) {
    candidate = source.headRef;
  } else if (source.kind === "checkout-change-request") {
    const base = candidate.slice(0, 90);
    for (let suffix = 1; await hasJjBookmark(sourceRoot, candidate); suffix++)
      candidate = `${base}-${suffix}`;
  }
  if (!ownsPrHead) {
    const branchValidation = validateBranchSlug(candidate);
    if (!branchValidation.valid) {
      throw new Error(`Invalid branch name: ${branchValidation.error}`);
    }
  }
  if (await hasJjBookmark(sourceRoot, candidate)) {
    throw new Error(`Bookmark already exists: ${candidate}`);
  }
  // Keep the workspace path slug independent from its bookmark. Owning the
  // PR's real head name lets normal jj push target that existing remote ref;
  // collisions keep the unique slug and remain fail-closed at publication.
  // Created from the workspace so it lands on the workspace head (@ there).
  await runJjWorkspaceSafe(["bookmark", "create", candidate], { cwd: worktreePath });
  if (ownsPrHead && publication) {
    // jj refuses a same-name remote ref until the local bookmark tracks it.
    await runJjWorkspaceSafe(["bookmark", "track", `${candidate}@${publication.remoteName}`], {
      cwd: worktreePath,
    });
  }
  const target = await readBookmarkTarget(sourceRoot, candidate);
  if (!target) throw new Error(`Created bookmark ${candidate} has no unique target`);
  return { name: candidate, target };
}

export async function rollbackJjWorkspace(
  primaryRoot: string,
  name: string,
  worktreePath: string,
  options?: { createdBookmark?: { name: string; target: string }; logger?: Pick<Logger, "warn"> },
): Promise<void> {
  return withWorkspaceLifecycle(worktreePath, async () => {
    try {
      // A failed forget must never be followed by filesystem removal.
      await runJj(["workspace", "forget", name], { cwd: primaryRoot });
      // jj cannot condition bookmark deletion on an expected target. Even an
      // apparently unchanged/conflicted bookmark may be adopted by external jj.
      if (options?.createdBookmark)
        options.logger?.warn(
          { retainedBookmark: options.createdBookmark.name, worktreePath },
          "Retained jj bookmark after workspace creation rollback; inspect before manual cleanup",
        );
      await removeDirectoryWithRetries(worktreePath);
    } catch (error) {
      // Rollback is best-effort; preserve the original creation failure.
      options?.logger?.warn(
        { err: error, worktreePath, retainedBookmark: options.createdBookmark?.name },
        "jj rollback cleanup failed; inspect retained workspace/bookmark artifacts",
      );
    }
  });
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
  if (result.truncated) throw new Error("jj workspace list was truncated");
  const entries = parseJjWorkspaceList(result.stdout);
  if (entries.length !== result.stdout.split("\n").filter((line) => line.trim()).length) {
    throw new Error("jj workspace list contained malformed entries");
  }
  return entries;
}

/**
 * Registered jj workspaces with Paseo ownership evidence. The primary
 * (default) workspace is skipped: it is the user's own checkout, not a Paseo
 * worktree, mirroring `git worktree list` filtering.
 */
export async function listJjPaseoWorktrees(options: {
  cwd: string;
  paseoHome?: string;
  worktreesRoot?: string;
}): Promise<PaseoWorktreeInfo[]> {
  const primaryRoot = await normalizePathForOwnership(options.cwd);
  const entries = await listJjWorkspaces(primaryRoot);
  const paseoOwned: PaseoWorktreeInfo[] = [];
  for (const entry of entries) {
    if (entry.name === "default") {
      continue;
    }
    const path = await normalizePathForOwnership(entry.root);
    const ownership = await isPaseoOwnedWorktreeCwd(path, { ...options, knownGitCommonDir: null });
    if (!ownership.allowed) {
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

/**
 * The directory exists on disk but jj no longer knows the workspace. That is
 * NOT proof of a prior safe deletion: an external `jj workspace forget`, a
 * truncated list, or a partial failure all look the same, and any surviving
 * files have no recovery pin. Deletion fails closed and the directory is
 * retained for manual recovery.
 */
export class JjUnregisteredWorkspaceError extends Error {
  constructor(path: string) {
    super(
      `The jj workspace registry no longer lists ${path}; its directory was retained ` +
        "because recoverability cannot be proven. Inspect it manually (jj workspace list / " +
        "op log) and remove it yourself if it is not needed.",
    );
    this.name = "JjUnregisteredWorkspaceError";
  }
}

/** Quarantine move failed; nothing was destroyed. */
export class JjQuarantineError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Failed to quarantine the jj workspace directory ${path}: ${String(cause)}`);
    this.name = "JjQuarantineError";
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
  reportQuarantine?: (path: string) => void;
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
 * only then forget + quarantine. Never touches the primary workspace.
 */
export async function deleteJjPaseoWorktree(options: DeleteJjPaseoWorktreeOptions): Promise<void> {
  return withWorkspaceLifecycle(options.worktreePath, () =>
    deleteJjWorkspaceUnderLifecycle(options),
  );
}

async function deleteJjWorkspaceUnderLifecycle(
  options: DeleteJjPaseoWorktreeOptions,
): Promise<void> {
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

  const ownership = await isPaseoOwnedWorktreeCwd(resolvedWorktree, {
    paseoHome: options.paseoHome,
    worktreesRoot: options.worktreesRoot ?? options.worktreesBaseRoot,
    knownGitCommonDir: null,
  });
  if (!ownership.allowed) {
    throw new Error("Refusing to delete non-Paseo worktree");
  }

  if (!match) {
    // Fail closed (data safety): a missing registration is not evidence of a
    // prior safe deletion — the directory is retained for manual recovery.
    throw new JjUnregisteredWorkspaceError(resolvedWorktree);
  }

  // The executor barrier drains/refuses this daemon's jj calls from this
  // root. It does not exclude filesystem writes, primary-cwd mutations or
  // external processes; quarantine preserves writes outside that barrier.
  await withJjDeletionTransaction(resolvedWorktree, async () => {
    // Teardown FIRST (agents/watchers/processes may write files): anything
    // teardown writes is captured by the snapshot that follows. The final
    // snapshot is the last chance external writes have to enter the pin; the
    // directory is then quarantined (moved aside, preserved) instead of
    // deleted, so even a write racing the move is never destroyed.
    const metadata = readPaseoWorktreeMetadata(resolvedWorktree);
    const branchName = metadata?.version === 2 ? (metadata.jjBookmark ?? "") : "";
    for (const teardownCwd of options.teardownCwds ?? [resolvedWorktree]) {
      // Repo-configured teardown commands are VCS-agnostic (paseo.json driven).
      await runWorktreeTeardownCommands({
        worktreePath: resolvedWorktree,
        teardownCwd,
        repoRootPath: primaryRoot,
        branchName,
      });
    }

    // Snapshot the workspace from inside it: reading `<name>@` from the
    // primary does NOT snapshot the secondary's files, so unsnapshotted edits
    // would be lost by forget+quarantine. The stale-safe run also recovers a
    // stale working copy.
    const snapshot = await runJjWorkspaceSafe(["status"], { cwd: resolvedWorktree });
    const untrackedPaths = parseUntrackedPaths(snapshot.stdout);
    if (untrackedPaths.length > 0) {
      throw new JjUnsnapshottedFilesError(untrackedPaths);
    }
    const headCommitId = await resolveWorkspaceHead(primaryRoot, match.name, resolvedWorktree);

    // Each archive creates/verifies a fresh private pin before forgetting.
    // Generations are never reused or automatically deleted; stale retirement
    // cannot address a later archive by the same workspace ID/name.
    const pin = recoveryPinName(`${options.pinKey ?? match.name}-${randomUUID()}`);
    await runJj(["bookmark", "create", pin, "--revision", headCommitId], { cwd: primaryRoot });
    const pinnedAt = await readBookmarkTarget(primaryRoot, pin);
    if (pinnedAt !== headCommitId) {
      throw new Error(`Recovery pin ${pin} did not land on the workspace head; aborting deletion`);
    }

    const change = await runJjWorkspaceSafe(
      ["log", "--no-graph", "-r", "@", "-T", 'change_id ++ "\\n"'],
      { cwd: resolvedWorktree },
    );
    const changeId = change.stdout.trim();
    if (!/^[k-z]{32}$/.test(changeId)) throw new Error("Cannot retain archive selection identity");
    const checkpoint = await importJjCheckpoint({
      backingRoot: resolvedWorktree,
      head: { commitId: headCommitId, changeId },
      paseoHome: options.paseoHome,
    });
    const archivedCheckpoint = await writeJjCheckpoint(
      {
        ...checkpoint,
        metadata: readPaseoWorktreeMetadata(resolvedWorktree),
        selection: { commitId: headCommitId, changeId },
        savedWip:
          checkpoint.selection.changeId === changeId
            ? checkpoint.savedWip
            : [...checkpoint.savedWip, checkpoint.selection],
        recoveryPins: [...checkpoint.recoveryPins, pin],
      },
      options.paseoHome,
    );
    await writeJjArchiveCheckpoint(archivedCheckpoint, pin, options.paseoHome);

    // 2. Durable persistence BEFORE forgetting. An empty workspace's change
    //    becomes unreachable after forget, so the pin bookmark is the only
    //    recoverable handle.
    if (options.persistRecoveryPin) {
      await options.persistRecoveryPin(pin);
    }

    // 3. Forget, then quarantine the directory (an atomic rename preserves
    //    every file — including any a racing external writer produced after
    //    the snapshot — instead of irrevocably removing them).
    await runJj(["workspace", "forget", match.name], { cwd: primaryRoot });
    const quarantinePath = await quarantineWorktreeDirectory(
      resolvedWorktree,
      primaryRoot,
      options,
    );
    if (quarantinePath) options.reportQuarantine?.(quarantinePath);
  });
}

/**
 * Move a deleted workspace's directory into the quarantine area under the
 * worktrees base root (outside `<base>/<hash>/`, so ownership and listings
 * ignore it). Never deletes; a failed move throws with the directory intact.
 */
async function quarantineWorktreeDirectory(
  worktreePath: string,
  primaryRoot: string,
  options: Pick<DeleteJjPaseoWorktreeOptions, "paseoHome" | "worktreesRoot" | "worktreesBaseRoot">,
): Promise<string | null> {
  if (!existsSync(worktreePath)) {
    return null;
  }
  const baseRoot = resolvePaseoWorktreesBaseRoot({
    paseoHome: options.paseoHome,
    worktreesRoot: options.worktreesRoot ?? options.worktreesBaseRoot,
  });
  const projectHash = await deriveJjWorktreeProjectHash(primaryRoot);
  const quarantinePath = join(
    baseRoot,
    ".quarantine",
    projectHash,
    `${basename(worktreePath)}-${randomUUID()}`,
  );
  mkdirSync(dirname(quarantinePath), { recursive: true });
  try {
    renameSync(worktreePath, quarantinePath);
    return quarantinePath;
  } catch (error) {
    throw new JjQuarantineError(worktreePath, error);
  }
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
  const targets = result.stdout.trim().split("\n").filter(Boolean);
  return result.exitCode === 0 && !result.truncated && targets.length === 1 ? targets[0]! : null;
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
  const ids = result.stdout.trim().split("\n");
  const commitId = ids[0];
  if (result.truncated || ids.length !== 1 || !/^[0-9a-f]{40,64}$/.test(commitId)) {
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
  await withWorkspaceLifecycle(options.worktreePath, () =>
    runJj(
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
    ),
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
