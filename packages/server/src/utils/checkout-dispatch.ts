import { resolve } from "node:path";
import type {
  BranchCheckoutResolution,
  BranchSuggestion,
  CheckoutContext,
  CheckoutDiffCompare,
  CheckoutDiffResult,
  CheckoutExistingBranchResult,
  CheckoutReadCacheOptions,
  CheckoutRefDerivedState,
  CheckoutShortstat,
  CheckoutSnapshotFacts,
  CheckoutStatusResult,
  CheckoutWorktreeState,
  PullRequestStatusResult,
} from "./checkout-git.js";
import {
  checkoutResolvedBranch,
  commitChanges,
  discardChanges,
  getCheckoutDiff,
  getCheckoutRefDerivedState,
  getCheckoutShortstat,
  getCheckoutSnapshotFacts,
  getCheckoutStatus,
  getCheckoutWorktreeState,
  getCommitFileDiff,
  getPullRequestStatus,
  listBranchSuggestions,
  listCheckoutCommits,
  mergeFromBase,
  mergeToBase,
  pullCurrentBranch,
  pushCurrentBranch,
  renameCurrentBranch,
  resolveAbsoluteGitDir,
  resolveBranchCheckout,
  resolveRepositoryDefaultBranch,
  type CheckoutCommitsResult,
} from "./checkout-git.js";
import { parseGitRevParsePath } from "./git-rev-parse-path.js";
import { runGitCommand, type RunGitCommand } from "./run-git-command.js";
import { runJjCommand } from "./run-jj-command.js";
import { listPaseoWorktrees, type PaseoWorktreeInfo } from "./worktree.js";
import { jjRevisionResolves, listJjPaseoWorktrees } from "./worktree-jj.js";
import type { ParsedDiffFile } from "../server/utils/diff-highlighter.js";
import {
  getJjCommitFileDiff,
  getJjDefaultBranch,
  getJjDiff,
  getJjRefDerivedState,
  getJjShortstat,
  getJjSnapshotFacts,
  getJjStatus,
  getJjWorktreeState,
  hasJjBookmark,
  jjCommit,
  jjCreateBookmark,
  jjDescribe,
  jjDiscard,
  jjFactsToCheckoutSnapshotFacts,
  jjNew,
  jjPull,
  jjPush,
  jjRenameBookmark,
  type JjMutationResult,
  listJjBookmarkSuggestions,
  listJjCommits,
  resolveJjBranchCheckout,
  type JjCheckoutContext,
} from "./checkout-jj.js";
import {
  detectVcsBackend,
  isJjDispatchEnabled,
  resolveJjRepoIdentity,
  resolveJjRuntime,
  type VcsBackend,
} from "./vcs-backend.js";

/**
 * Backend routing for the checkout surface — one policy point deciding whether
 * an operation runs against git or jj. Rules (jj plan §4):
 *
 * - Dispatch disabled (PASEO_JJ_DISPATCH=0) or a git/plain directory keeps
 *   today's behavior exactly: the git implementation's own detection applies.
 * - A jj repository with dispatch enabled routes to the jj implementation —
 *   never to git. When the jj runtime is unavailable (missing/old binary,
 *   PASEO_DISABLE_JJ), the operation fails with {@link JjUnavailableError}
 *   before any process spawns.
 * - jj operations without a mapping yet throw {@link NotSupportedOnJjError}
 *   instead of silently running git.
 */

/** The jj repository was detected, but the jj runtime cannot serve it. */
export class JjUnavailableError extends Error {
  constructor(
    readonly detectedVersion: string | null,
    reason: string,
  ) {
    super(
      `This project uses Jujutsu (jj), but jj is unavailable: ${reason}. ` +
        "Install jj >= 0.45.0 on the daemon's PATH or unset PASEO_DISABLE_JJ.",
    );
    this.name = "JjUnavailableError";
  }
}

/** The operation has no jj implementation yet (tracked in the jj plan). */
export class NotSupportedOnJjError extends Error {
  constructor(operation: string) {
    super(`${operation} is not supported on jj repositories yet`);
    this.name = "NotSupportedOnJjError";
  }
}

/**
 * Resolves the effective backend for a checkout operation. `null` means "run
 * the git implementation and let its own not-a-repo detection apply" — the
 * pre-jj behavior. A jj repository with a broken runtime throws
 * {@link JjUnavailableError} rather than falling back to git: secondary jj
 * workspaces have no usable local .git, and git discovery could otherwise
 * select an unrelated enclosing repository.
 */
export async function resolveEffectiveBackend(cwd: string): Promise<VcsBackend | "git-default"> {
  if (!isJjDispatchEnabled()) {
    return "git-default";
  }
  if (detectVcsBackend(cwd) !== "jj") {
    return "git-default";
  }
  const runtime = await resolveJjRuntime();
  if (!runtime.ok) {
    throw new JjUnavailableError(runtime.version, runtime.reason ?? "runtime probe failed");
  }
  return "jj";
}

function toJjContext(context?: CheckoutContext): JjCheckoutContext | undefined {
  return context
    ? { paseoHome: context.paseoHome, worktreesRoot: context.worktreesRoot, logger: context.logger }
    : undefined;
}

// ---------------------------------------------------------------- reads

export async function dispatchGetCheckoutSnapshotFacts(
  cwd: string,
  context?: CheckoutContext,
): Promise<CheckoutSnapshotFacts> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return getCheckoutSnapshotFacts(cwd, context);
  }
  const facts = await getJjSnapshotFacts(cwd, toJjContext(context));
  return jjFactsToCheckoutSnapshotFacts(facts);
}

export async function dispatchGetCheckoutStatus(
  cwd: string,
  context?: CheckoutContext,
): Promise<CheckoutStatusResult> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return getCheckoutStatus(cwd, context);
  }
  return getJjStatus(cwd, toJjContext(context));
}

export async function dispatchGetCheckoutShortstat(
  cwd: string,
  context?: CheckoutContext,
  options?: CheckoutReadCacheOptions,
): Promise<CheckoutShortstat | null> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return getCheckoutShortstat(cwd, context, options);
  }
  return getJjShortstat(cwd, toJjContext(context));
}

export async function dispatchGetCheckoutRefDerivedState(
  cwd: string,
  facts: Extract<CheckoutSnapshotFacts, { isGit: true }>,
  current: Pick<CheckoutRefDerivedState, "aheadBehind" | "diffStat">,
  movedRemoteRefs: ReadonlySet<string>,
  context?: CheckoutContext,
): Promise<CheckoutRefDerivedState> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return getCheckoutRefDerivedState(cwd, facts, current, movedRemoteRefs, context);
  }
  // jj derives all three fields from fresh jj facts; the git facts/current
  // inputs are git-shaped views of the same repository and carry no extra input
  // for the jj path. movedRemoteRefs has no jj equivalent until remote fetch
  // lands (Phase E).
  return getJjRefDerivedState(cwd, toJjContext(context));
}

export async function dispatchGetCheckoutWorktreeState(
  cwd: string,
  context: CheckoutContext,
): Promise<CheckoutWorktreeState> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return getCheckoutWorktreeState(cwd, context);
  }
  return getJjWorktreeState(cwd, toJjContext(context));
}

export async function dispatchGetCheckoutDiff(
  cwd: string,
  compare: CheckoutDiffCompare,
  context?: CheckoutContext,
): Promise<CheckoutDiffResult> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return getCheckoutDiff(cwd, compare, context);
  }
  return getJjDiff(cwd, compare, toJjContext(context));
}

export async function dispatchResolveRepositoryDefaultBranch(
  repoRoot: string,
  context?: CheckoutContext,
): Promise<string | null> {
  if ((await resolveEffectiveBackend(repoRoot)) !== "jj") {
    return resolveRepositoryDefaultBranch(repoRoot, context);
  }
  return getJjDefaultBranch(repoRoot, toJjContext(context));
}

export async function dispatchListBranchSuggestions(
  cwd: string,
  options?: { query?: string; limit?: number },
): Promise<BranchSuggestion[]> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return listBranchSuggestions(cwd, options);
  }
  return listJjBookmarkSuggestions(cwd, options);
}

export async function dispatchResolveBranchCheckout(
  cwd: string,
  name: string,
): Promise<BranchCheckoutResolution> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return resolveBranchCheckout(cwd, name);
  }
  return resolveJjBranchCheckout(cwd, name);
}

const READ_ONLY_ENV = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

// ---------------------------------------------------------------- mutations

export async function dispatchCommitChanges(
  cwd: string,
  options: { message: string; addAll?: boolean },
  context?: CheckoutContext,
): Promise<void> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return commitChanges(cwd, options);
  }
  // addAll is meaningless for jj: the working copy is always snapshotted in full.
  await jjCommit(cwd, { message: options.message }, toJjContext(context));
}

export async function dispatchDiscardChanges(cwd: string, paths: string[]): Promise<void> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return discardChanges(cwd, paths);
  }
  return jjDiscard(cwd, paths);
}

/**
 * Start a new working-copy change. jj-only surface (the git flow models the
 * same action as commit-then-continue); a git checkout gets a typed error
 * instead of a silent no-op.
 */
export async function dispatchNewChange(
  cwd: string,
  options?: { message?: string },
  context?: CheckoutContext,
): Promise<JjMutationResult> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    throw new NotSupportedOnJjError("New change (jj-only operation) requested on a git checkout");
  }
  return jjNew(cwd, options, toJjContext(context));
}

/** Describe (retitle) the current working-copy change. jj-only surface. */
export async function dispatchDescribeChange(
  cwd: string,
  options: { message: string },
  context?: CheckoutContext,
): Promise<JjMutationResult> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    throw new NotSupportedOnJjError(
      "Describe change (jj-only operation) requested on a git checkout",
    );
  }
  return jjDescribe(cwd, options, toJjContext(context));
}

/**
 * Execute a validated branch checkout. DEFERRED on jj: `jj edit` would make
 * the working copy rewrite the selected mutable change and leave managed
 * ownership stale, so the surface fails typed until a `jj new`-based flow
 * with an ownership transition lands (tracked in the jj plan).
 */
export async function dispatchExecuteBranchCheckout(
  cwd: string,
  resolution: BranchCheckoutResolution,
): Promise<CheckoutExistingBranchResult> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return checkoutResolvedBranch({ cwd, resolution });
  }
  throw new NotSupportedOnJjError(
    "Switching bookmarks is not supported on jj repositories yet; use jj new in a terminal",
  );
}

/** Execute branch creation from a base on the current working copy. Gates stay upstream. */
export async function dispatchExecuteCreateBranchFromBase(
  cwd: string,
  params: { baseBranch: string; newBranchName: string },
): Promise<void> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    await runGitCommand(["checkout", "-b", params.newBranchName, "--no-track", params.baseBranch], {
      cwd,
      timeout: 120_000,
    });
    return;
  }
  // New working-copy change ON THE VALIDATED BASE (review fix 12: `jj new`
  // on the current @ would stack the line on an unrelated change), then the
  // feature bookmark at that change. Advancement is pinned EMPTY for the
  // `jj new` so user config cannot move any existing bookmark; the new
  // bookmark becomes the line of work afterwards. The base is never moved.
  if (!(await jjRevisionResolves(cwd, params.baseBranch))) {
    throw new Error(`Base branch not found: ${params.baseBranch}`);
  }
  await runJjCommand(
    ["new", params.baseBranch, "--config", "experimental-advance-branches.enabled-branches=[]"],
    { cwd },
  );
  await jjCreateBookmark(cwd, params.newBranchName);
}

export async function dispatchHasLocalBranch(
  cwd: string,
  branch: string,
  runGit: RunGitCommand = runGitCommand,
): Promise<boolean> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    const ref = `refs/heads/${branch.trim()}`;
    const result = await runGit(["rev-parse", "--verify", "--quiet", ref], {
      cwd,
      envOverlay: READ_ONLY_ENV,
      acceptExitCodes: [0, 1],
    });
    return result.exitCode === 0;
  }
  return hasJjBookmark(cwd, branch.trim());
}

export async function dispatchResolveAbsoluteGitDir(
  cwd: string,
  context?: CheckoutContext,
): Promise<string | null> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return resolveAbsoluteGitDir(cwd, context);
  }
  const identity = resolveJjRepoIdentity(cwd);
  if (!identity) {
    return null;
  }
  return identity.colocated
    ? resolve(identity.primaryRoot, ".git")
    : resolve(identity.sharedStorePath, "store", "git");
}

export async function dispatchResolveCheckoutWatchRoot(
  cwd: string,
  runGit: RunGitCommand = runGitCommand,
): Promise<string | null> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    try {
      const { stdout } = await runGit(["rev-parse", "--show-toplevel"], {
        cwd,
        envOverlay: READ_ONLY_ENV,
      });
      return parseGitRevParsePath(stdout);
    } catch {
      return null;
    }
  }
  return resolveJjRepoIdentity(cwd)?.workspaceRoot ?? null;
}

// ------------------------------------------------------- intentionally limited

/**
 * Stash listing has no jj equivalent (jj has no stash); fail typed instead of
 * spawning git. Returns the raw `git stash list` output for git repos so the
 * service keeps its existing parsing.
 */
export async function dispatchRunStashList(
  cwd: string,
  runGit: RunGitCommand = runGitCommand,
): Promise<string> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    const result = await runGit(["stash", "list", "--format=%gd%x00%s"], {
      cwd,
      envOverlay: READ_ONLY_ENV,
    });
    return result.stdout;
  }
  throw new NotSupportedOnJjError("Stash listing");
}

/** jj has no stash; the app hides the surface and old clients get a typed error. */
export async function dispatchStashSave(cwd: string, message: string): Promise<void> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    await runGitCommand(["stash", "push", "--include-untracked", "-m", message], {
      cwd,
      timeout: 120_000,
    });
    return;
  }
  throw new NotSupportedOnJjError("Stash save");
}

export async function dispatchStashPop(cwd: string, stashIndex: number): Promise<void> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    await runGitCommand(["stash", "pop", `stash@{${stashIndex}}`], {
      cwd,
      timeout: 120_000,
    });
    return;
  }
  throw new NotSupportedOnJjError("Stash pop");
}

/** History reads: jj repos get jj changes; git keeps the git implementation. */
export async function dispatchListCheckoutCommits(
  cwd: string,
  context?: CheckoutContext,
): Promise<CheckoutCommitsResult> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return listCheckoutCommits({ cwd, context });
  }
  return listJjCommits({ cwd, context: toJjContext(context) });
}

export async function dispatchGetCommitFileDiff(
  cwd: string,
  sha: string,
  path: string,
): Promise<ParsedDiffFile | null> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return getCommitFileDiff({ cwd, sha, path });
  }
  return getJjCommitFileDiff({ cwd, change: sha, path });
}

/** Push the current line of work; jj pushes the workspace bookmark explicitly. */
export async function dispatchPushCurrentBranch(
  cwd: string,
  forgeService?: Parameters<typeof pushCurrentBranch>[1],
  context?: CheckoutContext,
): Promise<void> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return pushCurrentBranch(cwd, forgeService);
  }
  return jjPush(cwd, toJjContext(context));
}

/** Pull/fetch; jj fetches the selected remote (tracked bookmark import). */
export async function dispatchPullCurrentBranch(
  cwd: string,
  forgeService?: Parameters<typeof pullCurrentBranch>[1],
  context?: CheckoutContext,
): Promise<void> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return pullCurrentBranch(cwd, forgeService);
  }
  return jjPull(cwd, toJjContext(context));
}

/** Rename the current line of work (branch on git, bookmark on jj). */
export async function dispatchRenameCurrentBranch(
  cwd: string,
  branch: string,
  context?: CheckoutContext,
): Promise<{ previousBranch: string | null; currentBranch: string | null }> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return renameCurrentBranch(cwd, branch);
  }
  return jjRenameBookmark(cwd, branch, toJjContext(context));
}

/** Merge the workspace into its base — deferred on jj (plan §7). */
export async function dispatchMergeToBase(
  cwd: string,
  options: Parameters<typeof mergeToBase>[1],
  context?: CheckoutContext,
): Promise<string> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return mergeToBase(cwd, options, context);
  }
  throw new NotSupportedOnJjError(
    "Merging into the base is not supported on jj repositories yet; use jj rebase/squash in a terminal",
  );
}

/** Update the workspace from its base — deferred on jj (plan §7). */
export async function dispatchMergeFromBase(
  cwd: string,
  options: Parameters<typeof mergeFromBase>[1],
  context?: CheckoutContext,
): Promise<void> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return mergeFromBase(cwd, options, context);
  }
  throw new NotSupportedOnJjError(
    "Updating from the base is not supported on jj repositories yet; use jj git fetch and rebase in a terminal",
  );
}

/**
 * jj workspaces are not git worktrees; the git listing would only ever see the
 * main checkout. Phase D replaces this with `jj workspace list` — until then
 * jj repositories report no additional worktrees rather than spawning git.
 */
export async function dispatchListPaseoWorktrees(options: {
  cwd: string;
  paseoHome: string;
  worktreesRoot?: string;
}): Promise<PaseoWorktreeInfo[]> {
  if ((await resolveEffectiveBackend(options.cwd)) !== "jj") {
    return listPaseoWorktrees(options);
  }
  return listJjPaseoWorktrees(options);
}

/**
 * Forge PR status needs git plumbing (head sha, ref layout) that the jj path
 * does not provide yet; Phase E decides real forge integration. Meanwhile jj
 * repositories report the unauthenticated no-PR result without spawning git.
 */
export async function dispatchGetPullRequestStatus(
  cwd: string,
  forgeService: Parameters<typeof getPullRequestStatus>[1],
  options?: CheckoutReadCacheOptions,
  context?: CheckoutContext,
): Promise<PullRequestStatusResult> {
  if ((await resolveEffectiveBackend(cwd)) !== "jj") {
    return getPullRequestStatus(cwd, forgeService, options, context);
  }
  return { status: null, authState: "unauthenticated", githubFeaturesEnabled: false };
}
