import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let cachedJjAvailable: boolean | null = null;

/**
 * Synchronous one-shot probe used to skip jj-dependent suites locally when the
 * binary is absent. CI installs a pinned jj on every job that runs these
 * suites, so a skip on a CI runner means the install broke — the meta-test in
 * vcs-backend.test.ts asserts presence under `process.env.CI`.
 */
export function isJjAvailable(): boolean {
  if (cachedJjAvailable === null) {
    cachedJjAvailable =
      spawnSync("jj", ["--version"], { encoding: "utf8", timeout: 5_000 }).status === 0;
  }
  return cachedJjAvailable;
}

export function resetJjAvailabilityCache(): void {
  cachedJjAvailable = null;
}

export interface ScratchJjRepoFixture {
  /** Root of the scratch parent dir (cleaned up by the caller via dispose). */
  dir: string;
  /** The initialized jj repo root. */
  repoDir: string;
  /** Run jj in the fixture repo with deterministic config/env. */
  jj: (args: string[], cwd?: string) => { stdout: string; stderr: string; status: number | null };
  dispose: () => void;
}

const DETERMINISTIC_JJ_CONFIG = [
  "--config",
  "user.name=Paseo Test",
  "--config",
  "user.email=paseo-test@example.invalid",
] as const;

/**
 * Create a scratch jj repo with the real binary. Deterministic identity and
 * template isolation: user.name/user.email are pinned via --config and callers
 * always pass explicit templates/format flags (see run-jj-command.ts).
 */
export function createScratchJjRepo(options?: {
  colocate?: boolean;
  /** Extra files written before the initial commit: path -> content. */
  files?: Record<string, string>;
}): ScratchJjRepoFixture {
  const dir = mkdtempSync(join(tmpdir(), "paseo-jj-test-"));
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  const colocate = options?.colocate ?? true;
  const run = (args: string[], cwd: string) =>
    spawnSync("jj", [...DETERMINISTIC_JJ_CONFIG, "--no-pager", "--color", "never", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, JJ_EDITOR: "true" },
    });
  const init = run(
    colocate ? ["git", "init", "--colocate"] : ["git", "init", "--no-colocate"],
    repoDir,
  );
  if (init.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`jj git init failed: ${init.stderr}`);
  }
  // Production helpers run their own jj commands without the fixture's CLI overrides.
  // Persist identity so those mutations also work with an empty user config.
  for (const [key, value] of [
    ["user.name", "Paseo Test"],
    ["user.email", "paseo-test@example.invalid"],
  ] as const) {
    const configured = run(["config", "set", "--repo", key, value], repoDir);
    if (configured.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`jj config set failed: ${configured.stderr}`);
    }
  }
  const files = options?.files ?? {};
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(repoDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  if (Object.keys(files).length > 0) {
    const commit = run(["commit", "-m", "initial"], repoDir);
    if (commit.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`jj commit failed: ${commit.stderr}`);
    }
  }
  return {
    dir,
    repoDir,
    // cwd defaults to the repo root; passing a workspace dir targets it (the
    // run helper resolves the same deterministic config/env either way).
    jj: (args, cwd) => run(args, cwd ?? repoDir),
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
