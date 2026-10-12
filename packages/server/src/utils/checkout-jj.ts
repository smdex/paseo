import { resolve } from "node:path";
import type { ParsedDiffFile } from "../server/utils/diff-highlighter.js";
import { parseAndHighlightDiff, parseDiff } from "../server/utils/diff-highlighter.js";
import { isPaseoOwnedWorktreeCwd } from "./worktree.js";
import { readPaseoWorktreeMetadata } from "./worktree-metadata.js";
import { detectVcsBackend, resolveJjRepoIdentity, type JjRepoIdentity } from "./vcs-backend.js";
import {
  jjFilesetArg,
  runJjCommand,
  type JjCommandResult,
  type RunJjCommand,
} from "./run-jj-command.js";
import type {
  AheadBehind,
  CheckoutCommit,
  CheckoutCommitFile,
  CheckoutCommitsResult,
  CheckoutDiffCompare,
  CheckoutDiffResult,
  CheckoutSnapshotFacts,
  CheckoutStatusResult,
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
  return getRunJjCommand(context)(args, {
    cwd: options.cwd,
    maxOutputBytes: options.maxOutputBytes,
    acceptExitCodes: options.acceptExitCodes,
  });
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
  return remotes.find((remote) => remote.name === "origin") ?? remotes[0] ?? null;
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
  const names = (lines[0] ?? "").split("\t").filter((name) => name.length > 0);
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

/** True when a remote-tracking counterpart exists for the bookmark. */
async function hasTrackedRemoteBookmark(
  cwd: string,
  bookmark: string,
  context?: JjCheckoutContext,
): Promise<boolean> {
  const result = await runJj(
    ["log", "--no-graph", "-r", `remote_bookmarks("${bookmark}")`, "-T", COMMIT_ID_LINES_TEMPLATE],
    { cwd, acceptExitCodes: [0, 1] },
    context,
  );
  if (result.exitCode !== 0) {
    // Invalid bookmark pattern (weird characters) — treat as untracked.
    return false;
  }
  return countLines(result.stdout) > 0;
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

  // For colocated default workspaces the .paseo worktree metadata lives in the
  // git dir and reads normally. Native jj repos and secondary jj workspaces
  // have no .git at the root, so the reader throws; Phase D defines where jj
  // workspace metadata lives — until then absence is simply "no stored base".
  const metadata = ownership.owned
    ? readJjPaseoWorktreeMetadata(ownership.worktreeRoot ?? identity.workspaceRoot)
    : null;
  const storedBaseRef = storedBaseRefFromMetadata(metadata?.baseRefName, metadata?.baseRef);
  const resolvedBaseRef = storedBaseRef ?? (await resolveDefaultBookmark(cwd, context));
  const derivedBookmark = await deriveNearestAncestorBookmark(cwd, context);

  return {
    isJj: true,
    identity,
    workingCopy,
    derivedBookmark,
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
  const currentBranch = facts.derivedBookmark;
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
  if (!(await hasTrackedRemoteBookmark(cwd, bookmark, context))) {
    return null;
  }
  const remote = selectDefaultRemote(remotes);
  if (!remote) {
    return null;
  }
  const remoteBookmark = `remote_bookmarks("${bookmark}")`;
  const [ahead, behind] = await Promise.all([
    countRevset(cwd, `${remoteBookmark}..@`, context),
    countRevset(cwd, `@..${remoteBookmark}`, context),
  ]);
  return { ref: `${remote.name}/${bookmark}`, aheadBehind: { ahead, behind } };
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
  const currentBranch = jjFacts.derivedBookmark;
  const remoteUrl = selectDefaultRemote(jjFacts.remotes)?.url ?? null;
  const hasRemote = remoteUrl !== null;
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

  const common = {
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
  };

  if (jjFacts.paseoOwnedWorktree && baseRef) {
    return {
      isGit: true,
      ...common,
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

function fileSectionIsBinary(diffText: string, file: ParsedDiffFile, fileCount: number): boolean {
  const marker = file.isNew ? `--- /dev/null\n+++ b/${file.path}` : `--- a/${file.path}`;
  const sectionStart = diffText.indexOf(marker);
  if (sectionStart < 0) {
    // Diff headers quote paths with special characters, so the exact marker can
    // be absent. Only fall back to a whole-text match when the diff holds a
    // single file, where the marker cannot belong to another section.
    return fileCount === 1 && /Binary files .* differ/.test(diffText);
  }
  const nextFile = diffText.indexOf("diff --git ", sectionStart + marker.length);
  const section = diffText.slice(sectionStart, nextFile < 0 ? undefined : nextFile);
  return /Binary files .* differ/.test(section);
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
  const baseRef = compare.baseRef ?? jjFacts?.resolvedBaseRef ?? null;
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

  // One byte over the total cap so truncation is detectable.
  const result = await runJj(diffArgs, { cwd, maxOutputBytes: TOTAL_DIFF_MAX_BYTES + 1 }, context);
  if (result.truncated) {
    return { diff: "", structured: [], diffTooLarge: true };
  }
  const diffText = result.stdout;

  if (compare.includeStructured !== true) {
    return { diff: diffText };
  }

  const parsed = await parseAndHighlightDiff(diffText, cwd);
  const structured = applyDiffPlaceholders(parsed, diffText);
  return { diff: diffText, structured };
}

// ---------------------------------------------------------------- commits

interface JjFileCounts {
  additions: number;
  deletions: number;
}

/** Per-file line counts via the first-parent patch parsed by parseDiff. */
async function getJjChangeFileCounts(
  cwd: string,
  change: JjChangeMeta,
  context?: JjCheckoutContext,
): Promise<Map<string, JjFileCounts>> {
  const counts = new Map<string, JjFileCounts>();
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
    counts.set(file.path, { additions: file.additions, deletions: file.deletions });
  }
  return counts;
}

function toCheckoutCommit(
  record: RawLogRecord,
  counts: Map<string, JjFileCounts>,
  onRemoteCommitIds: Set<string>,
  workspaceCommitIds: Set<string>,
): CheckoutCommit {
  const { meta } = record;
  const files: CheckoutCommitFile[] = record.files.map((file) => {
    const fileCounts = counts.get(file.path);
    return {
      path: file.path,
      additions: fileCounts?.additions ?? 0,
      deletions: fileCounts?.deletions ?? 0,
      status: file.status,
    };
  });
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
  if (!baseRef) {
    return { baseRef: null, commits: [] };
  }

  const workspaceRange = `${baseRef}..@`;
  const [workspaceLog, baseLog, onRemoteCommitIds] = await Promise.all([
    runJj(["log", "--no-graph", "-r", workspaceRange, "-T", LOG_RECORD_TEMPLATE], { cwd }, context),
    runJj(
      [
        "log",
        "--no-graph",
        "-n",
        String(CHECKOUT_BASE_COMMIT_LIMIT),
        "-r",
        baseRef,
        "-T",
        LOG_RECORD_TEMPLATE,
      ],
      { cwd },
      context,
    ),
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
  const result = await runJj(diffArgs, { cwd, maxOutputBytes: PER_FILE_DIFF_MAX_BYTES }, context);
  if (result.stdout.trim().length === 0) {
    return null;
  }

  const oldRevision = meta.parents.length > 0 ? (meta.parents[0] ?? meta.commitId) : null;
  const parsedFiles = await parseAndHighlightDiff(result.stdout, cwd, {
    getOldFileContent: (file) =>
      oldRevision ? readJjFileContentAt(cwd, oldRevision, file.path, context) : null,
    getNewFileContent: (file) => readJjFileContentAt(cwd, meta.commitId, file.path, context),
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
