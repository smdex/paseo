import { resolve } from "node:path";
import type { ParsedDiffFile } from "../server/utils/diff-highlighter.js";
import { parseAndHighlightDiff, parseDiff } from "../server/utils/diff-highlighter.js";
import { isPaseoOwnedWorktreeCwd } from "./worktree.js";
import { readPaseoWorktreeMetadata, updatePaseoWorktreeJjBookmark } from "./worktree-metadata.js";
import { detectVcsBackend, resolveJjRepoIdentity, type JjRepoIdentity } from "./vcs-backend.js";
import {
  jjFilesetArg,
  runJjCommand,
  runJjCommandStaleSafe,
  type JjCommandResult,
  type RunJjCommand,
} from "./run-jj-command.js";
import type {
  AheadBehind,
  BranchCheckoutResolution,
  BranchSuggestion,
  CheckoutCommit,
  CheckoutCommitFile,
  CheckoutCommitsResult,
  CheckoutDiffCompare,
  CheckoutDiffResult,
  CheckoutRefDerivedState,
  CheckoutShortstat,
  CheckoutSnapshotFacts,
  CheckoutStatusResult,
  CheckoutWorktreeState,
  UpstreamStatus,
} from "./checkout-git.js";

/**
 * jj read operations producing the same wire shapes as their checkout-git.ts
 * counterparts. The mapping decisions are documented per function; the guiding
 * rules from the jj plan:
 *
 * - Bookmarks do not ride `@`: `currentBranch` is the workspace bookmark — the
 *   recorded feature bookmark when Paseo owns the workspace (Phase D writes the
 *   record), otherwise the unique nearest ancestor bookmark of `@`. Ambiguity
 *   resolves to null, never a guess.
 * - Display dirtiness = `@` has changes vs its parents OR jj refused to
 *   snapshot files ("Untracked paths:" in `jj status` — files over
 *   `snapshot.max-new-file-size`). Empty `@` alone proves nothing.
 * - History file diffs use a FIRST-PARENT baseline (`--from parents[0]`),
 *   matching git's `--diff-merges=first-parent`; plain `jj diff -r <merge>` is
 *   the combined-parent diff and returns nothing for clean merges.
 * - Structured templates always append explicit record separators: `json(self)`
 *   emits none on its own.
 */

const PER_FILE_DIFF_MAX_BYTES = 1024 * 1024; // 1MB — mirrors checkout-git.ts
const TOTAL_DIFF_MAX_BYTES = 2 * 1024 * 1024; // 2MB — mirrors checkout-git.ts
const CHECKOUT_BASE_COMMIT_LIMIT = 10; // mirrors checkout-git.ts base-history tail

// Record separator byte (ASCII 0x1e), embedded as a literal in jj template
// strings. json() escapes control characters inside string values, so this
// byte only ever originates from the template itself.
const RECORD_SEPARATOR = "\u001e";

export interface JjCheckoutContext {
  paseoHome?: string;
  worktreesRoot?: string;
  logger?: { trace?: unknown; warn?: unknown };
  /** Injectable executor for tests; production uses the module default. */
  runJjCommand?: RunJjCommand;
  /** Pre-resolved facts, mirroring CheckoutContext.facts reuse. */
  facts?: JjSnapshotFacts | null;
  signal?: AbortSignal;
}

function getRunJjCommand(context?: JjCheckoutContext): RunJjCommand {
  return context?.runJjCommand ?? runJjCommand;
}

interface JjCommandRunOptions {
  cwd: string;
  maxOutputBytes?: number;
  acceptExitCodes?: number[];
}

async function runJj(
  args: string[],
  options: JjCommandRunOptions,
  context?: JjCheckoutContext,
): Promise<JjCommandResult> {
  const runner = getRunJjCommand(context);
  // Every checkout-jj command runs with cwd = a workspace directory, so a
  // stale working copy (rewritten from another workspace) is recovered here
  // once instead of failing the read/mutation (review fix 15).
  const staleSafe = await runJjCommandStaleSafe(
    args,
    { ...options, signal: context?.signal },
    runner,
  );
  return {
    stdout: staleSafe.stdout,
    stderr: staleSafe.stderr,
    truncated: staleSafe.truncated,
    exitCode: staleSafe.exitCode,
    signal: null,
  };
}

// ---------------------------------------------------------------- templates

// One log record per revision: a json(self) line, then one line per changed
// file ("<status_char>\t<json-quoted path>"), then the record separator. json()
// escapes control characters inside strings, so the raw tab and separator bytes
// only ever come from this template.
const LOG_RECORD_TEMPLATE =
  'json(self) ++ "\\n" ++ ' +
  'self.diff().files().map(|f| f.status_char() ++ "\\t" ++ json(f.path()) ++ "\\n").join("") ++ ' +
  `"${RECORD_SEPARATOR}"`;

// json(self) line + "\t"-joined local bookmark names.
const CHANGE_META_TEMPLATE = `json(self) ++ "${RECORD_SEPARATOR}" ++ bookmarks.map(|b| b.name()).join("\\t") ++ "\\n"`;

const COMMIT_ID_LINES_TEMPLATE = 'commit_id ++ "\\n"';

// ---------------------------------------------------------------- types

export interface JjChangeAuthor {
  name: string;
  email: string;
  timestamp: string;
}

export interface JjChangeMeta {
  commitId: string;
  changeId: string;
  description: string;
  author: JjChangeAuthor;
  /** Parent commit ids, first-parent first. */
  parents: string[];
  /** Local bookmark names targeting this change. */
  bookmarks: string[];
}

export interface JjChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface JjWorkingCopyState {
  meta: JjChangeMeta;
  changedFiles: JjChangedFile[];
  /** Files jj refused to snapshot (over snapshot.max-new-file-size etc.). */
  untrackedPaths: string[];
  /** True when @ has no changes vs its parents. */
  empty: boolean;
}

export type JjSnapshotFacts =
  | { isJj: false }
  | {
      isJj: true;
      identity: JjRepoIdentity;
      workingCopy: JjWorkingCopyState;
      /** Unique nearest ancestor bookmark of @; null when ambiguous or absent. */
      derivedBookmark: string | null;
      /** Workspace-OWNED bookmark recorded in Paseo worktree metadata (managed workspaces). */
      managedBookmark: string | null;
      remotes: JjRemoteInfo[];
      storedBaseRef: string | null;
      resolvedBaseRef: string | null;
      paseoOwnedWorktree: boolean;
      worktreeRoot: string | null;
    };

export interface JjRemoteInfo {
  name: string;
  url: string;
}

// ---------------------------------------------------------------- parsing

interface RawLogRecord {
  meta: JjChangeMeta;
  files: JjChangedFile[];
}

interface RawChangeJson {
  commit_id: string;
  change_id: string;
  description: string;
  parents: string[];
  author: { name: string; email: string; timestamp: string };
}

function mapStatusChar(char: string): JjChangedFile["status"] | null {
  switch (char) {
    case "A":
    case "C":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return null;
  }
}

function parseChangeMeta(jsonLine: string, bookmarks: string[]): JjChangeMeta {
  const raw = JSON.parse(jsonLine) as RawChangeJson;
  return {
    commitId: raw.commit_id,
    changeId: raw.change_id,
    description: raw.description,
    parents: raw.parents,
    author: {
      name: raw.author.name,
      email: raw.author.email,
      timestamp: raw.author.timestamp,
    },
    bookmarks,
  };
}

function parseLogRecords(stdout: string): RawLogRecord[] {
  const records: RawLogRecord[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    if (record.trim().length === 0) {
      continue;
    }
    const lines = record.split("\n");
    const jsonLine = lines[0] ?? "";
    if (!jsonLine.startsWith("{")) {
      continue;
    }
    const files: JjChangedFile[] = [];
    for (const line of lines.slice(1)) {
      if (line.trim().length === 0) {
        continue;
      }
      const separator = line.indexOf("\t");
      if (separator <= 0) {
        continue;
      }
      const status = mapStatusChar(line.slice(0, separator));
      const path = JSON.parse(line.slice(separator + 1)) as string;
      if (status !== null && path.length > 0) {
        files.push({ path, status });
      }
    }
    records.push({ meta: parseChangeMeta(jsonLine, []), files });
  }
  return records;
}

function parseChangeMetaLines(stdout: string): JjChangeMeta | null {
  // One record: `json(self)` immediately followed by the record separator and
  // the "\t"-joined bookmark names (json(self) emits no newline of its own).
  const segments = stdout.split(RECORD_SEPARATOR);
  const jsonLine = segments[0] ?? "";
  if (!jsonLine.trim().startsWith("{")) {
    return null;
  }
  const bookmarkLine = (segments[1] ?? "").split("\n", 1)[0] ?? "";
  const bookmarks = bookmarkLine.length > 0 ? bookmarkLine.split("\t") : [];
  return parseChangeMeta(jsonLine, bookmarks);
}

function countLines(stdout: string): number {
  return stdout.split("\n").filter((line) => line.length > 0).length;
}

function parseRemotes(stdout: string): JjRemoteInfo[] {
  const remotes: JjRemoteInfo[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf(" ");
    if (separator <= 0) {
      continue;
    }
    remotes.push({ name: trimmed.slice(0, separator), url: trimmed.slice(separator + 1).trim() });
  }
  return remotes;
}

/** Extracts the "Untracked paths:" section paths from `jj status` stdout. */
function parseUntrackedPaths(statusStdout: string): string[] {
  const lines = statusStdout.split("\n");
  const paths: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line === "Untracked paths:") {
      inSection = true;
      continue;
    }
    if (!inSection) {
      continue;
    }
    if (line.startsWith("? ")) {
      paths.push(line.slice(2).trim());
      continue;
    }
    // Any other content ends the section.
    if (line.trim().length > 0) {
      break;
    }
  }
  return paths;
}

function selectDefaultRemote(remotes: JjRemoteInfo[]): JjRemoteInfo | null {
  if (remotes.length === 0) {
    return null;
  }
  return (
    remotes.find((remote) => remote.name === "origin") ?? (remotes.length === 1 ? remotes[0] : null)
  );
}

function subjectFromDescription(description: string): string {
  const firstLine = description.split("\n", 1)[0] ?? "";
  return firstLine.trim();
}

// ---------------------------------------------------------------- reads

async function getJjWorkingCopyState(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<JjWorkingCopyState> {
  // One log call for @ metadata + changed files; one status call for refused
  // (untracked) paths. Both snapshot the working copy first, so the two calls
  // observe the same state.
  const log = await runJj(
    ["log", "--no-graph", "-r", "@", "-T", LOG_RECORD_TEMPLATE],
    { cwd },
    context,
  );
  const records = parseLogRecords(log.stdout);
  const record = records[0];
  if (!record) {
    throw new Error(`jj returned no working-copy change for ${cwd}`);
  }
  const status = await runJj(["status"], { cwd }, context);
  return {
    meta: record.meta,
    changedFiles: record.files,
    untrackedPaths: parseUntrackedPaths(status.stdout),
    empty: record.files.length === 0,
  };
}

/**
 * The unique nearest ancestor bookmark of @: `heads(ancestors(@) & bookmarks())`
 * keeps only bookmarked commits that are not ancestors of another bookmarked
 * commit. Exactly one resulting commit carrying exactly one bookmark names the
 * workspace context; anything else (no bookmarks, multiple heads, multiple
 * bookmarks on one head) is ambiguous → null.
 */
async function deriveNearestAncestorBookmark(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<string | null> {
  const result = await runJj(
    [
      "log",
      "--no-graph",
      "-r",
      "heads(ancestors(@) & bookmarks())",
      "-T",
      'bookmarks.map(|b| b.name()).join("\\t") ++ "\\n"',
    ],
    { cwd },
    context,
  );
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1) {
    return null;
  }
  // Recovery pins can share a commit with real bookmarks (and ride ancestors
  // after restores), so they are excluded BY NAME here — a revset-level
  // complement would drop the shared commit entirely (verified on 0.45.1).
  const names = (lines[0] ?? "")
    .split("\t")
    .filter((name) => name.length > 0 && !name.startsWith("paseo/recovery/"));
  return names.length === 1 ? names[0] : null;
}

async function listJjRemotes(cwd: string, context?: JjCheckoutContext): Promise<JjRemoteInfo[]> {
  const result = await runJj(["git", "remote", "list"], { cwd }, context);
  return parseRemotes(result.stdout);
}

async function countRevset(
  cwd: string,
  revset: string,
  context?: JjCheckoutContext,
): Promise<number> {
  const result = await runJj(
    ["log", "--no-graph", "-r", revset, "-T", COMMIT_ID_LINES_TEMPLATE],
    { cwd },
    context,
  );
  return countLines(result.stdout);
}

async function listRemoteBookmarkCommitIds(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<Set<string>> {
  const result = await runJj(
    ["log", "--no-graph", "-r", "::remote_bookmarks()", "-T", COMMIT_ID_LINES_TEMPLATE],
    { cwd },
    context,
  );
  return new Set(result.stdout.split("\n").filter((line) => line.length > 0));
}

async function resolveDefaultBookmark(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<string | null> {
  for (const candidate of ["main", "master"]) {
    const result = await runJj(
      ["log", "--no-graph", "-r", `bookmarks("${candidate}")`, "-T", COMMIT_ID_LINES_TEMPLATE],
      { cwd },
      context,
    );
    if (countLines(result.stdout) > 0) {
      return candidate;
    }
  }
  return null;
}

export async function getJjChangeMeta(
  cwd: string,
  revset: string,
  context?: JjCheckoutContext,
): Promise<JjChangeMeta | null> {
  const result = await runJj(
    ["log", "--no-graph", "-r", revset, "-T", CHANGE_META_TEMPLATE],
    { cwd },
    context,
  );
  return parseChangeMetaLines(result.stdout);
}

// ---------------------------------------------------------------- facts

function storedBaseRefFromMetadata(
  baseRefName: string | undefined,
  baseRef: string | undefined,
): string | null {
  return baseRef ?? baseRefName ?? null;
}

function readJjPaseoWorktreeMetadata(worktreeRoot: string) {
  try {
    return readPaseoWorktreeMetadata(worktreeRoot);
  } catch {
    return null;
  }
}

async function resolvePaseoOwnedWorkspace(
  cwd: string,
  identity: JjRepoIdentity,
  context?: JjCheckoutContext,
): Promise<{ owned: boolean; worktreeRoot: string | null }> {
  // The ownership check resolves git's common dir when unknown; passing an
  // explicit null skips that git subprocess — a jj repo must not shell out to
  // git for its own facts.
  const ownership = await isPaseoOwnedWorktreeCwd(cwd, {
    paseoHome: context?.paseoHome,
    worktreesRoot: context?.worktreesRoot,
    knownGitCommonDir: null,
  });
  if (!ownership.allowed) {
    return { owned: false, worktreeRoot: null };
  }
  return { owned: true, worktreeRoot: identity.workspaceRoot };
}

export async function getJjSnapshotFacts(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<JjSnapshotFacts> {
  if (detectVcsBackend(cwd) !== "jj") {
    return { isJj: false };
  }
  const identity = resolveJjRepoIdentity(cwd);
  if (!identity) {
    return { isJj: false };
  }

  const [workingCopy, remotes, ownership] = await Promise.all([
    getJjWorkingCopyState(cwd, context),
    listJjRemotes(cwd, context),
    resolvePaseoOwnedWorkspace(cwd, identity, context),
  ]);

  // Worktree metadata: colocated default workspaces keep the git-dir
  // placement; jj workspaces (and native repos) persist it under
  // `.jj/paseo/worktree.json` (worktree-metadata.ts resolves both). Absence
  // simply means "no stored base" — e.g. the user's own unmanaged checkout.
  const metadata = ownership.owned
    ? readJjPaseoWorktreeMetadata(ownership.worktreeRoot ?? identity.workspaceRoot)
    : null;
  const storedBaseRef = storedBaseRefFromMetadata(metadata?.baseRefName, metadata?.baseRef);
  const managedBookmark = metadata?.version === 2 ? (metadata.jjBookmark ?? null) : null;
  const resolvedBaseRef = storedBaseRef ?? (await resolveDefaultBookmark(cwd, context));
  const derivedBookmark = await deriveNearestAncestorBookmark(cwd, context);

  return {
    isJj: true,
    identity,
    workingCopy,
    derivedBookmark,
    managedBookmark,
    remotes,
    storedBaseRef,
    resolvedBaseRef,
    paseoOwnedWorktree: ownership.owned,
    worktreeRoot: ownership.worktreeRoot,
  };
}

/**
 * Adapts jj facts onto the git-shaped CheckoutSnapshotFacts the service layer
 * and wire projections already consume. gitCommonDir/absoluteGitDir point at
 * the backing git store so observation code has the same anchor it has for git
 * repos (colocated: the root .git; native: the internal store git dir).
 */
export function jjFactsToCheckoutSnapshotFacts(facts: JjSnapshotFacts): CheckoutSnapshotFacts {
  if (!facts.isJj) {
    return { isGit: false };
  }
  const { identity } = facts;
  const gitDir = identity.colocated
    ? resolve(identity.primaryRoot, ".git")
    : resolve(identity.sharedStorePath, "store", "git");
  // One ownership resolver for reads and mutations alike (jjOwnedBookmark):
  // the recorded owner when Paseo manages this workspace (null included),
  // otherwise the derived unique nearest ancestor.
  const currentBranch = jjOwnedBookmark(facts);
  return {
    isGit: true,
    worktreeRoot: identity.workspaceRoot,
    currentBranch,
    remoteUrl: selectDefaultRemote(facts.remotes)?.url ?? null,
    absoluteGitDir: gitDir,
    gitCommonDir: gitDir,
    paseoWorktree: facts.paseoOwnedWorktree
      ? { isPaseoOwnedWorktree: true, worktreeRoot: facts.worktreeRoot ?? identity.workspaceRoot }
      : { isPaseoOwnedWorktree: false },
    storedBaseRef: facts.storedBaseRef,
    resolvedBaseRef: facts.resolvedBaseRef,
    mainRepoRoot: identity.primaryRoot,
    comparisonBaseRef: facts.resolvedBaseRef,
    branchRemoteName: selectDefaultRemote(facts.remotes)?.name ?? null,
    branchMergeRef: null,
    upstreamStatus: null,
    pullRequestLookupTarget: null,
  };
}

// ---------------------------------------------------------------- status

async function getJjAheadBehind(
  cwd: string,
  baseRef: string,
  currentBranch: string,
  context?: JjCheckoutContext,
): Promise<AheadBehind | null> {
  if (!baseRef || !currentBranch || baseRef === currentBranch) {
    return null;
  }
  const [ahead, behind] = await Promise.all([
    countRevset(cwd, `${baseRef}..@`, context),
    countRevset(cwd, `@..${baseRef}`, context),
  ]);
  return { ahead, behind };
}

async function getJjUpstreamStatus(
  cwd: string,
  bookmark: string | null,
  remotes: JjRemoteInfo[],
  context?: JjCheckoutContext,
): Promise<UpstreamStatus | null> {
  if (!bookmark || remotes.length === 0) {
    return null;
  }
  // Use the same selected remote as push; never compare against every remote
  // or the colocated "git" export view (neither is the push destination).
  const remote = selectDefaultRemote(remotes);
  if (!remote) return null;
  const remoteRef = `remote_bookmarks(exact:"${bookmark}", exact:"${remote.name}")`;
  const probe = await runJj(
    ["log", "--no-graph", "-r", remoteRef, "-T", COMMIT_ID_LINES_TEMPLATE],
    { cwd, acceptExitCodes: [0, 1] },
    context,
  );
  if (probe.exitCode !== 0 || probe.truncated || countLines(probe.stdout) === 0) return null;
  // Compare the BOOKMARK TARGET with its remote counterpart — the actual push
  // target. Counting against @ would include the automatic empty working-copy
  // change and keep a fully-pushed bookmark reading "ahead".
  const localRef = `bookmarks(exact:"${bookmark}")`;
  const [ahead, behind] = await Promise.all([
    countRevset(cwd, `${remoteRef}..${localRef}`, context),
    countRevset(cwd, `${localRef}..${remoteRef}`, context),
  ]);
  return { ref: `${remote.name}/${bookmark}`, aheadBehind: { ahead, behind } };
}

async function getJjDefaultWorkspaceBase({
  cwd,
  currentBranch,
  context,
}: {
  cwd: string;
  currentBranch: string | null;
  context?: JjCheckoutContext;
}): Promise<{ refName: string; displayName: string }> {
  const suggestions = currentBranch
    ? await listJjBookmarkSuggestions(cwd, { query: currentBranch }, context)
    : [];
  const current = suggestions.find((suggestion) => suggestion.name === currentBranch);
  const defaultWorkspaceBase = current
    ? { refName: current.remoteRef ?? current.localRef ?? "@", displayName: current.name }
    : { refName: "@", displayName: "Current change" };
  return defaultWorkspaceBase;
}

export async function getJjStatus(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<CheckoutStatusResult> {
  const jjFacts = context?.facts ?? (await getJjSnapshotFacts(cwd, context));
  if (!jjFacts.isJj) {
    return { isGit: false };
  }

  const { identity, workingCopy } = jjFacts;
  const currentBranch = jjOwnedBookmark(jjFacts);
  const remoteUrl = selectDefaultRemote(jjFacts.remotes)?.url ?? null;
  const hasRemote = jjFacts.remotes.length > 0;
  const isDirty = !workingCopy.empty || workingCopy.untrackedPaths.length > 0;
  const baseRef = jjFacts.resolvedBaseRef;
  const factsContext = { ...context, facts: jjFacts };

  const aheadBehind =
    baseRef && currentBranch
      ? await getJjAheadBehind(cwd, baseRef, currentBranch, factsContext)
      : null;
  const upstreamStatus = await getJjUpstreamStatus(
    cwd,
    currentBranch,
    jjFacts.remotes,
    factsContext,
  );

  const defaultWorkspaceBase = await getJjDefaultWorkspaceBase({ cwd, currentBranch, context });
  const common = {
    defaultWorkspaceBase,
    repoRoot: identity.workspaceRoot,
    currentBranch,
    isDirty,
    baseRef,
    aheadBehind,
    upstreamRef: upstreamStatus?.ref ?? null,
    aheadOfOrigin: upstreamStatus?.aheadBehind.ahead ?? null,
    behindOfOrigin: upstreamStatus?.aheadBehind.behind ?? null,
    hasRemote,
    remoteUrl,
    vcs: "jj" as const,
    changeId: workingCopy.meta.changeId,
  };

  if (jjFacts.paseoOwnedWorktree && baseRef) {
    return {
      isGit: true,
      ...common,
      baseRef,
      mainRepoRoot: identity.primaryRoot,
      isPaseoOwnedWorktree: true,
    };
  }

  return {
    isGit: true,
    ...common,
    mainRepoRoot:
      identity.primaryRoot && resolve(identity.primaryRoot) !== resolve(identity.workspaceRoot)
        ? identity.primaryRoot
        : null,
    isPaseoOwnedWorktree: false,
  };
}

// ---------------------------------------------------------------- diff

function buildPlaceholderParsedDiffFile(
  file: ParsedDiffFile,
  status: "binary" | "too_large",
): ParsedDiffFile {
  return {
    path: file.path,
    isNew: file.isNew,
    isDeleted: file.isDeleted,
    additions: 0,
    deletions: 0,
    hunks: [],
    status,
  };
}

/** Split a git-format diff into per-file `diff --git` sections. */
function splitDiffSections(diffText: string): string[] {
  return diffText.split(/^(?=diff --git )/m).filter((section) => section.length > 0);
}

function fileSectionIsBinary(diffText: string, file: ParsedDiffFile, fileCount: number): boolean {
  // Binary sections carry no ---/+++ headers, so the file is located by its
  // `diff --git` section — never by a whole-text match when multiple files
  // are present (the marker could belong to another file's section).
  if (fileCount === 1) {
    return /Binary files .* differ/.test(diffText);
  }
  return splitDiffSections(diffText).some(
    (section) =>
      parseDiff(section).some((entry) => entry.path === file.path) &&
      /Binary files .* differ/.test(section),
  );
}

function serializeFileBytes(file: ParsedDiffFile): number {
  return Buffer.byteLength(JSON.stringify(file), "utf8");
}

function applyDiffPlaceholders(files: ParsedDiffFile[], diffText: string): ParsedDiffFile[] {
  return files.map((file) => {
    if (file.hunks.length === 0 && fileSectionIsBinary(diffText, file, files.length)) {
      return buildPlaceholderParsedDiffFile(file, "binary");
    }
    if (serializeFileBytes(file) > PER_FILE_DIFF_MAX_BYTES) {
      return buildPlaceholderParsedDiffFile(file, "too_large");
    }
    return file;
  });
}

async function resolveJjDiffRefs(
  cwd: string,
  compare: CheckoutDiffCompare,
  context?: JjCheckoutContext,
): Promise<string[] | null> {
  if (compare.mode === "uncommitted") {
    // jj diff with no revision diffs the working copy change @ against its
    // parents — the combined-parent baseline documented in the plan.
    return ["diff", "--git"];
  }
  const jjFacts = context?.facts ?? (await getJjSnapshotFacts(cwd, context));
  const baseRef = compare.baseRef ?? (jjFacts?.isJj ? jjFacts.resolvedBaseRef : null) ?? null;
  if (!baseRef) {
    return null;
  }
  return ["diff", "--git", "--from", baseRef, "--to", "@"];
}

export async function getJjDiff(
  cwd: string,
  compare: CheckoutDiffCompare,
  context?: JjCheckoutContext,
): Promise<CheckoutDiffResult> {
  const diffArgs = await resolveJjDiffRefs(cwd, compare, context);
  if (!diffArgs) {
    return { diff: "" };
  }
  if (compare.ignoreWhitespace === true) {
    diffArgs.push("--ignore-all-space");
  }

  // Diff paths and highlighter content reads are workspace-root-relative.
  const root = await jjWorkspaceRoot(cwd);
  // One byte over the total cap so truncation is detectable.
  const result = await runJj(
    diffArgs,
    { cwd: root, maxOutputBytes: TOTAL_DIFF_MAX_BYTES + 1 },
    context,
  );
  if (result.truncated) {
    return { diff: "", structured: [], diffTooLarge: true };
  }
  const diffText = result.stdout;

  if (compare.includeStructured !== true) {
    return { diff: diffText };
  }

  const parsed = await parseAndHighlightDiff(diffText, root);
  const structured = applyDiffPlaceholders(parsed, diffText);
  return { diff: diffText, structured };
}

// ---------------------------------------------------------------- commits

interface JjFileCounts {
  additions: number;
  deletions: number;
}

/** Per-file line counts via the first-parent patch parsed by parseDiff. */
interface JjFirstParentFile {
  counts: JjFileCounts;
  status: JjChangedFile["status"] | null;
}

async function getJjChangeFileCounts(
  cwd: string,
  change: JjChangeMeta,
  context?: JjCheckoutContext,
): Promise<Map<string, JjFirstParentFile>> {
  const counts = new Map<string, JjFirstParentFile>();
  const diffArgs =
    change.parents.length === 0
      ? ["diff", "--git", "-r", change.commitId]
      : ["diff", "--git", "--from", change.parents[0] ?? change.commitId, "--to", change.commitId];
  const result = await runJj(
    diffArgs,
    { cwd, maxOutputBytes: PER_FILE_DIFF_MAX_BYTES * 4, acceptExitCodes: [0] },
    context,
  );
  if (result.truncated) {
    // Oversized change: keep statuses from the log record, lose exact counts.
    return counts;
  }
  for (const file of parseDiff(result.stdout)) {
    let status: JjChangedFile["status"] = "modified";
    if (file.isNew) {
      status = "added";
    } else if (file.isDeleted) {
      status = "deleted";
    }
    counts.set(file.path, {
      counts: { additions: file.additions, deletions: file.deletions },
      status,
    });
  }
  return counts;
}

function toCheckoutCommit(
  record: RawLogRecord,
  counts: Map<string, JjFirstParentFile>,
  onRemoteCommitIds: Set<string>,
  workspaceCommitIds: Set<string>,
): CheckoutCommit {
  const { meta } = record;
  // Files/statuses come from the SAME first-parent diff that produced the
  // counts (review fix 13): the log record's combined-parent file list is
  // empty for clean merges and would hide second-parent files. Status chars
  // are kept when the path matches the record; parseDiff flags map otherwise.
  const files: CheckoutCommitFile[] =
    counts.size > 0
      ? [...counts.entries()].map(([path, file]) => ({
          path,
          additions: file.counts.additions,
          deletions: file.counts.deletions,
          status: file.status ?? "modified",
        }))
      : // Oversized change (counts truncated): keep the record's file list
        // with unknown counts rather than showing no files at all.
        record.files.map((file) => ({
          path: file.path,
          additions: 0,
          deletions: 0,
          status: file.status,
        }));
  return {
    sha: meta.commitId,
    shortSha: meta.commitId.slice(0, 12),
    subject: subjectFromDescription(meta.description),
    authorName: meta.author.name,
    authorDate: meta.author.timestamp,
    isOnRemote: onRemoteCommitIds.has(meta.commitId),
    isOnBase: !workspaceCommitIds.has(meta.commitId),
    files,
  };
}

function isNoiseWorkingCopyChange(record: RawLogRecord): boolean {
  // The auto-created empty, undescribed @ would render as an empty entry git
  // never has; drop it. Described or non-empty @ is real workspace state.
  return record.files.length === 0 && subjectFromDescription(record.meta.description) === "";
}

export async function listJjCommits({
  cwd,
  context,
}: {
  cwd: string;
  context?: JjCheckoutContext;
}): Promise<CheckoutCommitsResult> {
  const jjFacts = context?.facts ?? (await getJjSnapshotFacts(cwd, context));
  if (!jjFacts?.isJj) {
    return { baseRef: null, commits: [] };
  }
  const baseRef = jjFacts.resolvedBaseRef;
  const workspaceRange = baseRef ? `${baseRef}..@` : "::@ ~ root()";
  const [workspaceLog, baseLog, onRemoteCommitIds] = await Promise.all([
    runJj(
      [
        "log",
        "--no-graph",
        ...(baseRef ? [] : ["-n", String(CHECKOUT_BASE_COMMIT_LIMIT)]),
        "-r",
        workspaceRange,
        "-T",
        LOG_RECORD_TEMPLATE,
      ],
      { cwd },
      context,
    ),
    baseRef
      ? runJj(
          [
            "log",
            "--no-graph",
            "-n",
            String(CHECKOUT_BASE_COMMIT_LIMIT),
            "-r",
            `::${baseRef}`,
            "-T",
            LOG_RECORD_TEMPLATE,
          ],
          { cwd },
          context,
        )
      : Promise.resolve({ stdout: "" }),
    listRemoteBookmarkCommitIds(cwd, context),
  ]);

  const workspaceRecords = parseLogRecords(workspaceLog.stdout).filter(
    (record) => !isNoiseWorkingCopyChange(record),
  );
  const baseRecords = parseLogRecords(baseLog.stdout).filter(
    (record) => !isNoiseWorkingCopyChange(record),
  );
  const records = [...workspaceRecords, ...baseRecords];
  if (records.length === 0) {
    return { baseRef, commits: [] };
  }

  const workspaceCommitIds = new Set(workspaceRecords.map((record) => record.meta.commitId));
  const commits: CheckoutCommit[] = [];
  for (const record of records) {
    const counts = await getJjChangeFileCounts(cwd, record.meta, context);
    commits.push(toCheckoutCommit(record, counts, onRemoteCommitIds, workspaceCommitIds));
  }
  return { baseRef, commits };
}

// ---------------------------------------------------------------- commit file diff

async function readJjFileContentAt(
  cwd: string,
  revision: string,
  path: string,
  context?: JjCheckoutContext,
): Promise<string | null> {
  const fileset = jjFilesetArg([path]);
  if (!fileset) {
    return null;
  }
  try {
    const result = await runJj(
      ["file", "show", "-r", revision, ...fileset],
      { cwd, maxOutputBytes: PER_FILE_DIFF_MAX_BYTES },
      context,
    );
    if (result.truncated) {
      // Truncated content would highlight a PREFIX as the whole file;
      // treat it as unavailable (no highlight) instead of wrong content.
      return null;
    }
    return result.stdout;
  } catch {
    // Absent at the revision (added or deleted file) or binary over the cap.
    return null;
  }
}

/**
 * Unified diff of one file as introduced by one change, on the FIRST-PARENT
 * baseline (parents[0] from json(self)); the combined-parent `jj diff -r` is
 * empty for clean merges and would hide second-parent files. Mirrors
 * getCommitFileDiff: null when the file is absent or the change is binary.
 */
export async function getJjCommitFileDiff({
  cwd,
  change,
  path,
  context,
}: {
  cwd: string;
  change: string;
  path: string;
  context?: JjCheckoutContext;
}): Promise<ParsedDiffFile | null> {
  const meta = await getJjChangeMeta(cwd, change, context);
  if (!meta) {
    return null;
  }
  const fileset = jjFilesetArg([path]);
  if (!fileset) {
    return null;
  }
  // Paths are workspace-root-relative: run from the workspace ROOT so a
  // subdirectory caller cannot make the fileset select the wrong file.
  const root = await jjWorkspaceRoot(cwd);
  const diffArgs =
    meta.parents.length === 0
      ? ["diff", "--git", "-r", meta.commitId, ...fileset]
      : [
          "diff",
          "--git",
          "--from",
          meta.parents[0] ?? meta.commitId,
          "--to",
          meta.commitId,
          ...fileset,
        ];
  const result = await runJj(
    diffArgs,
    { cwd: root, maxOutputBytes: PER_FILE_DIFF_MAX_BYTES },
    context,
  );
  if (result.truncated) {
    // Never parse a truncated patch as a complete diff — surface the
    // oversized placeholder the git path uses for the same situation.
    return {
      path,
      isNew: false,
      isDeleted: false,
      additions: 0,
      deletions: 0,
      hunks: [],
      status: "too_large",
    };
  }
  if (result.stdout.trim().length === 0) {
    return null;
  }

  const oldRevision = meta.parents.length > 0 ? (meta.parents[0] ?? meta.commitId) : null;
  const parsedFiles = await parseAndHighlightDiff(result.stdout, root, {
    getOldFileContent: async (file) =>
      oldRevision ? readJjFileContentAt(root, oldRevision, file.path, context) : null,
    getNewFileContent: (file) => readJjFileContentAt(root, meta.commitId, file.path, context),
  });

  // The fileset scopes the diff to one path, so at most one real entry exists;
  // pick by path to drop stray header-only sections.
  const file = parsedFiles.find((candidate) => candidate.path === path) ?? null;
  if (!file) {
    return null;
  }
  if (file.hunks.length === 0 && /Binary files .* differ/.test(result.stdout)) {
    return null;
  }
  return file;
}

// ------------------------------------------------------- dispatch helpers

/**
 * Summed additions/deletions of the working-copy change, mirroring
 * getCheckoutShortstat's {additions, deletions} contract. Untracked-refused
 * files are excluded (jj reports no hunks for them); callers that must not
 * miss them read the facts' untrackedPaths directly.
 */
export async function getJjShortstat(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<CheckoutShortstat | null> {
  const result = await runJj(["diff", "--git"], { cwd }, context);
  if (result.stdout.trim().length === 0) {
    return null;
  }
  const files = parseDiff(result.stdout);
  if (files.length === 0) {
    return null;
  }
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

/** Ref-derived state for the service's incremental refresh, jj-flavored. */
export async function getJjRefDerivedState(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<CheckoutRefDerivedState> {
  const jjFacts = context?.facts ?? (await getJjSnapshotFacts(cwd, context));
  if (!jjFacts.isJj) {
    return { aheadBehind: null, diffStat: null, upstreamStatus: null };
  }
  const currentBranch = jjOwnedBookmark(jjFacts);
  const baseRef = jjFacts.resolvedBaseRef;
  const factsContext = { ...context, facts: jjFacts };
  const [aheadBehind, diffStat, upstreamStatus] = await Promise.all([
    baseRef && currentBranch ? getJjAheadBehind(cwd, baseRef, currentBranch, factsContext) : null,
    getJjShortstat(cwd, factsContext),
    getJjUpstreamStatus(cwd, currentBranch, jjFacts.remotes, factsContext),
  ]);
  return { aheadBehind, diffStat, upstreamStatus };
}

/** Worktree state for the service's worktree refresh, jj-flavored. */
export async function getJjWorktreeState(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<CheckoutWorktreeState> {
  const [jjFacts, diffStat] = await Promise.all([
    context?.facts ?? getJjSnapshotFacts(cwd, context),
    getJjShortstat(cwd, context),
  ]);
  const isDirty =
    jjFacts.isJj && (!jjFacts.workingCopy.empty || jjFacts.workingCopy.untrackedPaths.length > 0);
  return { isDirty, diffStat };
}

/** Default bookmark ("main", then "master"); null when neither exists. */
export async function getJjDefaultBranch(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<string | null> {
  return resolveDefaultBookmark(cwd, context);
}

/** Bookmark existence probe backing the service's hasLocalBranch surface. */
export async function hasJjBookmark(
  cwd: string,
  name: string,
  context?: JjCheckoutContext,
): Promise<boolean> {
  const result = await runJj(
    ["log", "--no-graph", "-r", `bookmarks("${name}")`, "-T", COMMIT_ID_LINES_TEMPLATE],
    { cwd, acceptExitCodes: [0, 1] },
    context,
  );
  if (result.exitCode !== 0) {
    // Invalid bookmark pattern (weird characters) — treat as absent.
    return false;
  }
  return countLines(result.stdout) > 0;
}

interface JjBookmarkListEntry {
  name: string;
  commitId: string;
  committerDate: number;
}

function parseBookmarkEntries(result: JjCommandResult): JjBookmarkListEntry[] {
  if (result.truncated) throw new Error("jj bookmark list was truncated");
  const entries: JjBookmarkListEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [name, commitId, date] = line.split("\t");
    const committerDate = Number(date);
    if (!name || !/^[0-9a-f]{40,64}$/.test(commitId) || !Number.isFinite(committerDate)) {
      throw new Error("Invalid jj bookmark target");
    }
    if (!name.startsWith("paseo/recovery/")) entries.push({ name, commitId, committerDate });
  }
  return entries;
}

function uniqueBookmarkEntries(entries: JjBookmarkListEntry[]): Map<string, JjBookmarkListEntry> {
  const targets = new Map<string, JjBookmarkListEntry>();
  for (const entry of entries) {
    if (targets.has(entry.name)) throw new Error(`Conflicted bookmark: ${entry.name}`);
    targets.set(entry.name, entry);
  }
  return targets;
}

export async function listJjBookmarkSuggestions(
  cwd: string,
  options?: { query?: string; limit?: number },
  context?: JjCheckoutContext,
): Promise<BranchSuggestion[]> {
  const remote = selectDefaultRemote(await listJjRemotes(cwd, context));
  const template =
    'b.name() ++ "\\t" ++ commit_id ++ "\\t" ++ self.committer().timestamp().format("%s") ++ "\\n"';
  const localResult = await runJj(
    ["log", "--no-graph", "-r", "bookmarks()", "-T", `bookmarks.map(|b| ${template}).join("")`],
    { cwd },
    context,
  );
  const remoteResult = remote
    ? await runJj(
        [
          "log",
          "--no-graph",
          "-r",
          `remote_bookmarks(remote=exact:${JSON.stringify(remote.name)})`,
          "-T",
          `remote_bookmarks.filter(|b| b.remote() == ${JSON.stringify(remote.name)}).map(|b| ${template}).join("")`,
        ],
        { cwd },
        context,
      )
    : null;
  const localEntries = parseBookmarkEntries(localResult);
  const remoteEntries = remoteResult ? parseBookmarkEntries(remoteResult) : [];
  const locals = uniqueBookmarkEntries(localEntries);
  const remotes = uniqueBookmarkEntries(remoteEntries);
  const names = new Set([...locals.keys(), ...remotes.keys()]);
  const suggestions: BranchSuggestion[] = [];
  for (const name of names) {
    if (options?.query && !name.includes(options.query)) continue;
    const local = locals.get(name);
    const remoteEntry = remotes.get(name);
    const identical = local && remoteEntry && local.commitId === remoteEntry.commitId;
    suggestions.push({
      name,
      committerDate: Math.max(local?.committerDate ?? 0, remoteEntry?.committerDate ?? 0),
      hasLocal: local !== undefined,
      hasRemote: remoteEntry !== undefined,
      localRef: local?.commitId,
      remoteRef: remoteEntry?.commitId,
      remoteName: remoteEntry ? remote?.name : undefined,
      ...(identical ? { localAhead: 0, localBehind: 0 } : {}),
    });
  }
  suggestions.sort((a, b) => b.committerDate - a.committerDate || a.name.localeCompare(b.name));
  return options?.limit === undefined ? suggestions : suggestions.slice(0, options.limit);
}

/** Bookmark-backed branch checkout resolution for validation flows. */
export async function resolveJjBranchCheckout(
  cwd: string,
  name: string,
): Promise<BranchCheckoutResolution> {
  if (await hasJjBookmark(cwd, name)) {
    return { kind: "local", name };
  }
  return { kind: "not-found" };
}

// ---------------------------------------------------------------- mutations

const SAFE_JJ_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function assertSafeJjRef(name: string, label: string): void {
  if (!SAFE_JJ_REF_PATTERN.test(name)) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
}

/**
 * The workspace root for path-taking operations. jj filesets and `file show`
 * paths resolve RELATIVE TO CWD, while diff headers and the wire send
 * workspace-root-relative paths — running from a subdirectory would select
 * the WRONG file. Every path-scoped command executes from this root.
 */
async function jjWorkspaceRoot(cwd: string): Promise<string> {
  return resolveJjRepoIdentity(cwd)?.workspaceRoot ?? resolve(cwd);
}

/**
 * The single ownership resolver (reads AND mutations): a managed Paseo
 * workspace owns exactly the bookmark recorded in its metadata — including
 * null (bookmarkless managed workspaces never fall back to ancestor
 * inference, which could pick the base). Unmanaged checkouts derive the
 * unique nearest ancestor bookmark.
 */
function jjOwnedBookmark(facts: Extract<JjSnapshotFacts, { isJj: true }>): string | null {
  return facts.paseoOwnedWorktree ? facts.managedBookmark : facts.derivedBookmark;
}

/**
 * The bookmark that represents this workspace's line of work: the unique
 * nearest-ancestor bookmark of @. Everything the mutation layer advances or
 * moves refers to this bookmark (the stored base ref is never touched).
 */
export async function getJjWorkspaceBookmark(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<string | null> {
  const facts = context?.facts ?? (await getJjSnapshotFacts(cwd, context));
  if (!facts.isJj) {
    return null;
  }
  return jjOwnedBookmark(facts);
}

function advanceBookmarkArgs(bookmark: string | null): string[] {
  // Null ownership pins the EMPTY allow-list: user config could otherwise
  // advance unrelated bookmarks (e.g. the base) during our mutations
  // (review fix 7). Verified on 0.45.1: an empty list disables advancement.
  if (!bookmark) {
    return ["--config", "experimental-advance-branches.enabled-branches=[]"];
  }
  assertSafeJjRef(bookmark, "bookmark");
  // Scoped to exactly this bookmark (glob with no wildcards), so the base
  // bookmark and unrelated bookmarks never advance. Verified on 0.45.1: jj
  // new/jj commit move the bookmark onto the finished change, not the empty
  // working-copy child, keeping the workspace line git-visible.
  return ["--config", `experimental-advance-branches.enabled-branches=["${bookmark}"]`];
}

export interface JjMutationResult {
  /** Change id of the (new) working-copy change after the mutation. */
  changeId: string;
  /** Commit id of the working-copy change after the mutation. */
  commitId: string;
  /** Workspace bookmark advanced onto the working-copy change, if any. */
  bookmark: string | null;
}

const WORKING_COPY_IDS_TEMPLATE = 'change_id ++ "\\n" ++ commit_id ++ "\\n"';

async function readWorkingCopyIds(
  cwd: string,
  context?: JjCheckoutContext,
): Promise<{ changeId: string; commitId: string }> {
  const result = await runJj(
    ["log", "--no-graph", "-r", "@", "-T", WORKING_COPY_IDS_TEMPLATE],
    { cwd },
    context,
  );
  const [changeId, commitId] = result.stdout.trim().split("\n");
  if (!changeId || !commitId) {
    throw new Error(`jj returned no working-copy ids for ${cwd}`);
  }
  return { changeId, commitId };
}

/**
 * Finish the current change and start a new empty working-copy change.
 * `jj commit` = describe @ + new @; with the advance config the workspace
 * bookmark moves onto the finished change, so the work lands ON the bookmark
 * line (git-visible in colocated repos) exactly like a git branch tip.
 */
export async function jjCommit(
  cwd: string,
  options: { message: string },
  context?: JjCheckoutContext,
): Promise<JjMutationResult> {
  const message = options.message.trim();
  if (!message) {
    throw new Error("Commit message is required");
  }
  const bookmark = await getJjWorkspaceBookmark(cwd, context);
  await runJj(["commit", "-m", message, ...advanceBookmarkArgs(bookmark)], { cwd }, context);
  return finishMutation(cwd, bookmark, context);
}

/** Start a new working-copy change on top of the current one, keeping it. */
export async function jjNew(
  cwd: string,
  options?: { message?: string },
  context?: JjCheckoutContext,
): Promise<JjMutationResult> {
  const bookmark = await getJjWorkspaceBookmark(cwd, context);
  const message = options?.message?.trim();
  await runJj(
    ["new", ...(message ? ["-m", message] : []), ...advanceBookmarkArgs(bookmark)],
    { cwd },
    context,
  );
  return finishMutation(cwd, bookmark, context);
}

/** Set or replace the description of the current working-copy change. */
export async function jjDescribe(
  cwd: string,
  options: { message: string },
  context?: JjCheckoutContext,
): Promise<JjMutationResult> {
  const message = options.message.trim();
  if (!message) {
    throw new Error("Description is required");
  }
  await runJj(["describe", "-m", message], { cwd }, context);
  return finishMutation(cwd, null, context);
}

/**
 * Discard working-copy changes to the given paths (restore them from the
 * parent). Empty path list is a no-op, mirroring git's discardChanges.
 * Paths are workspace-root-relative, so the restore runs from the workspace
 * ROOT even when the caller sits in a subdirectory.
 */
export async function jjDiscard(cwd: string, paths: string[]): Promise<void> {
  const fileset = jjFilesetArg(paths);
  if (!fileset) {
    return;
  }
  const root = await jjWorkspaceRoot(cwd);
  await runJj(["restore", ...fileset], { cwd: root });
}

async function finishMutation(
  cwd: string,
  bookmark: string | null,
  context?: JjCheckoutContext,
): Promise<JjMutationResult> {
  const ids = await readWorkingCopyIds(cwd, context);
  return { ...ids, bookmark };
}

/**
 * Create a bookmark on the current working-copy change. Mirrors the git
 * branch-creation flow: the workspace continues on a fresh bookmarked line.
 */
export async function jjCreateBookmark(cwd: string, name: string): Promise<void> {
  assertSafeJjRef(name, "bookmark");
  await runJj(["bookmark", "create", name], { cwd });
}

/**
 * Move a bookmark to a revision, guarded by its expected current target so a
 * stale expectation fails loudly instead of silently skipping.
 */
export async function jjMoveBookmark(
  cwd: string,
  name: string,
  options: { fromRevset: string; toRevset: string },
  context?: JjCheckoutContext,
): Promise<void> {
  assertSafeJjRef(name, "bookmark");
  // `--from` mismatches exit 0 with "No bookmarks to update" (verified on
  // 0.45.1), so the guard must be verified, not trusted.
  const bookmarkHere = `bookmarks.match("${name}").len() ++ "\\n"`;
  const before = await runJj(
    ["log", "--no-graph", "-r", options.fromRevset, "-T", bookmarkHere],
    { cwd },
    context,
  );
  if (before.stdout.trim() !== "1") {
    throw new Error(`Bookmark ${name} is not at the expected revision`);
  }
  await runJj(
    [
      "bookmark",
      "move",
      "--allow-backwards",
      name,
      "--from",
      options.fromRevset,
      "--to",
      options.toRevset,
    ],
    { cwd },
    context,
  );
  const after = await runJj(
    ["log", "--no-graph", "-r", options.toRevset, "-T", bookmarkHere],
    { cwd },
    context,
  );
  if (after.stdout.trim() !== "1") {
    throw new Error(`Failed to move bookmark ${name}`);
  }
}

// ------------------------------------------------------------- remote ops

export class JjPushTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JjPushTargetError";
  }
}

/**
 * The remote push/fetch target: the single configured remote, "origin" when
 * present, and a typed error naming the candidates when ambiguous (never a
 * silent default — user config could otherwise redirect pushes).
 */
async function selectJjRemote(cwd: string, context?: JjCheckoutContext): Promise<JjRemoteInfo> {
  const remotes = await listJjRemotes(cwd, context);
  if (remotes.length === 0) {
    throw new JjPushTargetError("No git remote is configured for this repository.");
  }
  const selected = selectDefaultRemote(remotes);
  if (selected) return selected;
  const names = remotes.map((remote) => remote.name).join(", ");
  throw new JjPushTargetError(
    `Multiple git remotes are configured (${names}); set up tracking or push a specific bookmark.`,
  );
}

/**
 * Push the workspace bookmark. jj refuses undescribed commits (verified:
 * "Won't push commit <id> since it has no description") — the message is
 * surfaced verbatim as an actionable error. A bookmarkless checkout fails
 * typed: pushing requires a named line of work (plan §7).
 */
export async function jjPush(cwd: string, context?: JjCheckoutContext): Promise<void> {
  const bookmark = await getJjWorkspaceBookmark(cwd, context);
  if (!bookmark) {
    throw new JjPushTargetError(
      "No bookmark tracks this line of work yet. Describe the change and create a bookmark before pushing.",
    );
  }
  const remote = await selectJjRemote(cwd, context);
  await runJj(["git", "push", "--bookmark", bookmark, "--remote", remote.name], { cwd }, context);
}

/**
 * Fetch the selected remote. jj imports tracked bookmarks; the working copy
 * keeps its changes and new upstream commits appear as ancestors of the
 * tracked bookmarks (the jj-native update flow — rebase/merge is explicit).
 */
export async function jjPull(cwd: string, context?: JjCheckoutContext): Promise<void> {
  const remote = await selectJjRemote(cwd, context);
  await runJj(
    ["--config", "git.abandon-unreachable-commits=false", "git", "fetch", "--remote", remote.name],
    { cwd },
    context,
  );
}

/**
 * Rename the workspace bookmark (`jj bookmark rename OLD NEW`, verified on
 * 0.45.1). Returns the previous and current names for the wire payload.
 */
export async function jjRenameBookmark(
  cwd: string,
  newName: string,
  context?: JjCheckoutContext,
): Promise<{ previousBranch: string | null; currentBranch: string | null }> {
  assertSafeJjRef(newName, "bookmark");
  const bookmark = await getJjWorkspaceBookmark(cwd, context);
  if (!bookmark) {
    throw new Error("No bookmark tracks this line of work, so there is nothing to rename.");
  }
  if (bookmark === newName) {
    return { previousBranch: bookmark, currentBranch: bookmark };
  }
  if (await hasJjBookmark(cwd, newName, context)) {
    throw new Error(`Bookmark already exists: ${newName}`);
  }
  await runJj(["bookmark", "rename", bookmark, newName], { cwd }, context);
  // Keep managed ownership metadata current: a renamed owner must stop
  // resolving through the stale recorded name. The metadata lives at the
  // WORKSPACE ROOT (a subdirectory caller must not be refused), and the
  // update preserves every other metadata field (runtime port, first-agent
  // auto-name state) by patching only jjBookmark.
  const identity = resolveJjRepoIdentity(cwd);
  if (identity) {
    const owned = await isPaseoOwnedWorktreeCwd(cwd, {
      knownGitCommonDir: null,
      paseoHome: context?.paseoHome,
      worktreesRoot: context?.worktreesRoot,
    });
    if (owned.allowed) {
      updatePaseoWorktreeJjBookmark(identity.workspaceRoot, {
        from: bookmark,
        to: newName,
      });
    }
  }
  return { previousBranch: bookmark, currentBranch: newName };
}
