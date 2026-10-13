import { spawn } from "node:child_process";
import { readFileSync, statSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type VcsBackend = "jj" | "git" | "none";

/**
 * Nearest-repository-boundary walk-up. At EVERY ancestor (starting at `cwd`)
 * both `.jj` and `.git` are checked; the first ancestor owning either wins.
 * A nested git repo inside a jj repo stays git (and vice versa). When one
 * directory holds both markers (colocated jj repo), jj wins — jj is preferred
 * when the project has a jj repo.
 *
 * Pure fs, independent of jj runtime availability; no caching (a stat walk is
 * cheap next to any subprocess).
 */
export function detectVcsBackend(cwd: string): VcsBackend {
  let current = resolve(cwd);
  // Walk up until the filesystem root.
  for (;;) {
    if (hasDirEntry(current, ".jj")) {
      return "jj";
    }
    if (hasDirEntry(current, ".git")) {
      return "git";
    }
    const parent = dirname(current);
    if (parent === current) {
      return "none";
    }
    current = parent;
  }
}

function hasDirEntry(dir: string, entry: string): boolean {
  try {
    statSync(join(dir, entry));
    return true;
  } catch {
    return false;
  }
}

export interface JjRuntimeProbe {
  ok: boolean;
  /** Parsed version string when the binary answered, e.g. "0.45.1". */
  version: string | null;
  reason?: "not-found" | "disabled" | "version" | "failed";
}

/** Minimum jj version with the CLI surface Paseo depends on (filesets, workspaces, templates). */
export const MINIMUM_JJ_VERSION = "0.45.0";

export function parseJjVersion(stdout: string): string | null {
  // `jj --version` prints `jj 0.45.1`.
  const match = /^jj\s+(\d+\.\d+\.\d+)/.exec(stdout.trim());
  return match?.[1] ?? null;
}

export function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string): number[] => value.split(".").map((part) => Number(part));
  const actual = parse(version);
  const floor = parse(minimum);
  for (let index = 0; index < Math.max(actual.length, floor.length); index += 1) {
    const a = actual[index] ?? 0;
    const b = floor[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

let jjRuntimeProbeCache: Promise<JjRuntimeProbe> | null = null;
/** Sync-readable mirror of the resolved probe (set once the promise settles). */
let jjRuntimeProbeResolved: JjRuntimeProbe | null = null;
/** Bumped on reset so a stale in-flight probe cannot repopulate the mirror. */
let jjRuntimeProbeGeneration = 0;

/** Test seam: drop the cached probe so env changes take effect. */
export function resetJjRuntimeCache(): void {
  jjRuntimeProbeCache = null;
  jjRuntimeProbeResolved = null;
  jjRuntimeProbeGeneration += 1;
}

/**
 * Opt-in activation switch. Detected jj repositories refuse VCS operations
 * when disabled; they never fall back to Git discovery.
 */
export function isJjDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Opt-in until the Phase F activation flips the default: every jj path
  // (dispatch, observation, advertisement) stays dormant unless explicitly
  // enabled, so incomplete surfaces are never exposed to ordinary users.
  return env.PASEO_JJ_DISPATCH === "1";
}

/**
 * Whether the daemon may advertise the `checkoutJj` feature: the jj runtime
 * is usable AND dispatch is enabled. This is the same gate dispatch routing
 * uses (per-repo detection aside), so a client never sees the feature advertised
 * for a daemon that would route a jj repo to git — or the reverse.
 *
 * Synchronous on purpose: server_info construction is sync. Call
 * {@link warmJjRuntime} once at daemon startup so the first server_info already
 * reflects the probe; before warm-up completes this returns false.
 */
export function isJjFeatureAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isJjDispatchEnabled(env) || env.PASEO_DISABLE_JJ === "1") {
    return false;
  }
  return jjRuntimeProbeResolved?.ok === true;
}

/** Fire-and-forget startup warm-up for {@link isJjFeatureAvailable}. */
export function warmJjRuntime(): void {
  void resolveJjRuntime();
}

/**
 * Cached daemon-wide probe of the jj binary: present on PATH, version at least
 * MINIMUM_JJ_VERSION, not disabled via PASEO_DISABLE_JJ=1. Success and failure
 * are both cached for the process lifetime; callers do not re-probe per call.
 * The `env` argument only gates the disable flag; the binary is probed from
 * the real process PATH.
 */
export function resolveJjRuntime(env: NodeJS.ProcessEnv = process.env): Promise<JjRuntimeProbe> {
  if (env.PASEO_DISABLE_JJ === "1") {
    return Promise.resolve({ ok: false, version: null, reason: "disabled" });
  }
  if (!jjRuntimeProbeCache) {
    const generation = jjRuntimeProbeGeneration;
    const probe = probeJjBinary().then((result) => {
      if (generation === jjRuntimeProbeGeneration) {
        jjRuntimeProbeResolved = result;
      }
      return result;
    });
    jjRuntimeProbeCache = probe;
  }
  return jjRuntimeProbeCache;
}

function probeJjBinary(): Promise<JjRuntimeProbe> {
  return new Promise<JjRuntimeProbe>((resolveProbe) => {
    let settled = false;
    const child = spawn("jj", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdoutChunks: Buffer[] = [];
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => resolveProbe({ ok: false, version: null, reason: "failed" }));
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(() =>
        resolveProbe(
          error.code === "ENOENT"
            ? { ok: false, version: null, reason: "not-found" }
            : { ok: false, version: null, reason: "failed" },
        ),
      );
    });
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        settle(() => resolveProbe({ ok: false, version: null, reason: "failed" }));
        return;
      }
      const version = parseJjVersion(Buffer.concat(stdoutChunks).toString("utf8"));
      if (!version) {
        settle(() => resolveProbe({ ok: false, version: null, reason: "failed" }));
        return;
      }
      if (!isVersionAtLeast(version, MINIMUM_JJ_VERSION)) {
        settle(() => resolveProbe({ ok: false, version, reason: "version" }));
        return;
      }
      settle(() => resolveProbe({ ok: true, version }));
    });
  });
}

export interface JjRepoIdentity {
  /** `jj root` for THIS workspace: the directory containing its `.jj`. */
  workspaceRoot: string;
  /**
   * Absolute path of the shared repo directory (`<repo>/.jj/repo`). Secondary
   * workspaces hold a pointer file at `.jj/repo`; this resolves through it, so
   * every workspace of one repo reports the same sharedStorePath. Use this —
   * not workspaceRoot — for grouping, scheduling, and managed paths.
   */
  sharedStorePath: string;
  /** True when the shared store's git target is the repo root's `.git` directory. */
  colocated: boolean;
  /**
   * Primary (default-workspace) checkout path: the directory containing the
   * shared store's `.jj`. Distinct from workspaceRoot for secondary workspaces.
   */
  primaryRoot: string;
}

/**
 * Resolve the jj repo identity for a directory whose detected backend is "jj".
 * Returns null when the `.jj` layout cannot be read (repo being created or
 * torn down mid-flight) — callers treat that as "not a usable jj repo right
 * now", never as a different backend.
 */
export function resolveJjRepoIdentity(cwd: string): JjRepoIdentity | null {
  const workspaceRoot = findJjRoot(resolve(cwd));
  if (!workspaceRoot) {
    return null;
  }
  const repoPointer = join(workspaceRoot, ".jj", "repo");
  let repoStat;
  try {
    repoStat = statSync(repoPointer);
  } catch {
    return null;
  }

  let sharedStorePath: string;
  if (repoStat.isFile()) {
    // Secondary workspace: `.jj/repo` is a file whose content is the path to
    // the shared repo directory, relative to this workspace's `.jj` directory.
    let target: string;
    try {
      target = readFileSync(repoPointer, "utf8").trim();
    } catch {
      return null;
    }
    if (!target) {
      return null;
    }
    sharedStorePath = resolve(join(workspaceRoot, ".jj"), target);
  } else if (repoStat.isDirectory()) {
    sharedStorePath = repoPointer;
  } else {
    return null;
  }

  const primaryRoot = dirname(dirname(sharedStorePath));
  const colocated = isColocatedStore(sharedStorePath, primaryRoot);
  // Canonicalize the store path (realpath with fallback) so a symlinked
  // primary and its secondary workspaces report ONE shared identity — the
  // grouping key for observation and probe coalescing.
  let canonicalStorePath = sharedStorePath;
  try {
    canonicalStorePath = realpathSync(sharedStorePath);
  } catch {
    // keep the lexical path when realpath fails (race with removal)
  }
  return { workspaceRoot, sharedStorePath: canonicalStorePath, colocated, primaryRoot };
}

function findJjRoot(startDir: string): string | null {
  let current = startDir;
  for (;;) {
    // .jj first: a colocated root (both .jj and .git) IS a jj repo. Then .git
    // blocks the walk: a nested repository is its own repo, never observed
    // through an enclosing jj store.
    if (hasDirEntry(current, ".jj")) {
      return current;
    }
    if (hasDirEntry(current, ".git")) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function isColocatedStore(sharedStorePath: string, primaryRoot: string): boolean {
  let gitTarget: string;
  try {
    gitTarget = readFileSync(join(sharedStorePath, "store", "git_target"), "utf8").trim();
  } catch {
    return false;
  }
  // Internal store: `git_target` is the literal string "git" (store lives at
  // `<repo>/.jj/repo/store/git`). Otherwise it is a path — relative to the
  // `store` directory — to the backing git dir; colocated means that resolves
  // to `<primaryRoot>/.git`.
  if (gitTarget === "git") {
    return false;
  }
  const resolvedTarget = resolve(join(sharedStorePath, "store"), gitTarget);
  return resolvedTarget === join(primaryRoot, ".git");
}
