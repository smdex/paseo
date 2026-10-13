import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import type { Logger } from "pino";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import { spawnProcess } from "./spawn.js";
import {
  GitProcessScheduler,
  type GitProcessPriority,
  type GitProcessPolicy,
} from "./git-process-scheduler.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20MB
const DEFAULT_STDERR_LIMIT = 2048;

/**
 * jj subprocess limits mirror the git policy shape (`daemon.git` config drives
 * git; jj gets the same defaults until a `daemon.jj` equivalent exists).
 * Env overrides: PASEO_JJ_MAX_PROCESSES_PER_SECOND / PASEO_JJ_MAX_PROCESS_CONCURRENCY.
 */
function resolveJjProcessPolicy(env: NodeJS.ProcessEnv): GitProcessPolicy {
  return {
    maxProcessesPerSecond: parsePositiveInteger(env.PASEO_JJ_MAX_PROCESSES_PER_SECOND) ?? 64,
    maxProcessConcurrency: parsePositiveInteger(env.PASEO_JJ_MAX_PROCESS_CONCURRENCY) ?? 8,
  };
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface JjCommandOptions {
  cwd: string;
  input?: string | Buffer;
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
  logger?: Pick<Logger, "trace">;
  timeout?: number;
  maxOutputBytes?: number;
  acceptExitCodes?: number[];
}

export interface JjCommandResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type RunJjCommand = (args: string[], options: JjCommandOptions) => Promise<JjCommandResult>;

/**
 * Minimal structural port of the child-process surface the executor consumes.
 * `spawnProcess` satisfies it; tests provide a typed fake (see
 * run-jj-command.test.ts). Keeps the executor testable without module mocks.
 */
export interface JjProcessStdout {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface JjProcessStdin {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  end(data?: string | Buffer): void;
}

export interface JjChildProcess {
  readonly stdout: JjProcessStdout | null;
  readonly stderr: JjProcessStdout | null;
  readonly stdin: JjProcessStdin | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type JjSpawnFn = (
  command: string,
  args: string[],
  options?: import("./spawn.js").SpawnProcessOptions,
) => JjChildProcess;

export interface JjCommandExecutorDeps {
  /**
   * Injectable spawn for tests (timing/output-cap cases that are not
   * deterministic against a real binary). Production uses `spawnProcess`.
   */
  spawn?: JjSpawnFn;
}

/**
 * Headless determinism for every jj invocation. `--no-pager` and `--color never`
 * must be passed explicitly: user config (ui.pager, colors, ui.diff-formatter
 * with `--color=always`) otherwise hijacks piped output. JJ_EDITOR=true keeps
 * `jj describe`-style commands from ever opening an editor and hanging.
 */
const JJ_GLOBAL_ARGS = ["--no-pager", "--color", "never"] as const;

const JJ_ENV_OVERLAY: ProcessEnvRecord = {
  JJ_EDITOR: "true",
  LC_ALL: "C",
};

let jjProcessScheduler = new GitProcessScheduler(resolveJjProcessPolicy(process.env));
const jjCommandPriority = new AsyncLocalStorage<GitProcessPriority>();

export function runWithJjCommandPriority<T>(priority: GitProcessPriority, operation: () => T): T {
  return jjCommandPriority.run(priority, operation);
}

export function getJjProcessPolicy(): GitProcessPolicy {
  return jjProcessScheduler.policy;
}

/** Test seam: rebuild the scheduler from env (mirrors configureGitProcessPolicy). */
export function configureJjProcessPolicy(env: NodeJS.ProcessEnv): void {
  jjProcessScheduler = new GitProcessScheduler(resolveJjProcessPolicy(env));
}

export function createRunJjCommand(provenance: string, deps?: JjCommandExecutorDeps): RunJjCommand {
  const spawn: JjSpawnFn = deps?.spawn ?? spawnProcess;
  return (args, options) =>
    executeJjCommand(args, options, spawn, {
      provenance,
      scheduler: () => jjProcessScheduler,
      priority: () => jjCommandPriority.getStore() ?? "normal",
    });
}

export const runJjCommand: RunJjCommand = createRunJjCommand("default");

interface JjExecutionContext {
  provenance: string;
  scheduler: () => GitProcessScheduler;
  priority: () => GitProcessPriority;
}

function executeJjCommand(
  args: string[],
  options: JjCommandOptions,
  spawn: JjSpawnFn,
  context: JjExecutionContext,
): Promise<JjCommandResult> {
  const startCommand = () => {
    let releaseProcessSlot!: () => void;
    const exited = new Promise<void>((resolve) => {
      releaseProcessSlot = resolve;
    });
    const resultPromise = new Promise<JjCommandResult>((resolve, reject) => {
      const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const acceptExitCodes = options.acceptExitCodes ?? [0];
      const command = formatJjCommand(args);
      const envOverlay: ProcessEnvRecord = {
        ...options.envOverlay,
        ...JJ_ENV_OVERLAY,
      };
      const startedAt = Date.now();
      const logger = typeof options.logger?.trace === "function" ? options.logger : undefined;

      if (logger) {
        logger.trace(
          {
            provenance: context.provenance,
            args,
            cwd: options.cwd,
            cwdExists: existsSync(options.cwd),
            timeout,
            maxOutputBytes,
            acceptExitCodes,
          },
          "Spawning jj command",
        );
      }

      let settled = false;
      let processError: Error | null = null;
      let processExit: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
      let timeoutError: Error | null = null;
      let truncated = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback();
      };

      const markProcessExited = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (processExit) return;
        processExit = { exitCode, signal };
        releaseProcessSlot();
      };

      const rejectSpawnFailure = (error: unknown) => {
        processError = error instanceof Error ? error : new Error(String(error));
        markProcessExited(null, null);
        settle(() => reject(processError));
      };

      let child: JjChildProcess;
      try {
        child = spawn("jj", [...JJ_GLOBAL_ARGS, ...args], {
          cwd: options.cwd,
          envOverlay,
          shell: false,
          stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (error) {
        rejectSpawnFailure(error);
        return;
      }

      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdout || !stderr) {
        child.kill("SIGKILL");
        rejectSpawnFailure(new Error("jj process did not expose piped stdout and stderr"));
        return;
      }

      timer = setTimeout(() => {
        timeoutError = new Error(
          `jj command timed out after ${timeout}ms: ${command} (provenance: ${context.provenance})`,
        );
        child.kill("SIGKILL");
        settle(() => reject(timeoutError));
      }, timeout);

      stdout.on("data", (chunk: Buffer | string) => {
        if (settled || truncated) return;

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remainingBytes = maxOutputBytes - stdoutBytes;

        if (remainingBytes <= 0) {
          truncated = true;
          child.kill("SIGKILL");
          return;
        }

        if (buffer.length > remainingBytes) {
          stdoutChunks.push(buffer.subarray(0, remainingBytes));
          stdoutBytes += remainingBytes;
          truncated = true;
          child.kill("SIGKILL");
          return;
        }

        stdoutChunks.push(buffer);
        stdoutBytes += buffer.length;
      });

      stderr.on("data", (chunk: Buffer | string) => {
        if (settled || stderrBytes >= DEFAULT_STDERR_LIMIT) return;

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remainingBytes = DEFAULT_STDERR_LIMIT - stderrBytes;

        if (buffer.length > remainingBytes) {
          stderrChunks.push(buffer.subarray(0, remainingBytes));
          stderrBytes += remainingBytes;
          return;
        }

        stderrChunks.push(buffer);
        stderrBytes += buffer.length;
      });

      child.on("error", (error) => {
        processError = error;
        if (logger) {
          logger.trace(
            {
              provenance: context.provenance,
              err: error,
              durationMs: Date.now() - startedAt,
            },
            "jj command process error",
          );
        }
      });

      if (options.input !== undefined) {
        child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
          // A command may close stdin when it exits or reaches the output limit.
          if (error.code !== "EPIPE") {
            processError = error;
            child.kill("SIGKILL");
          }
        });
        child.stdin?.end(options.input);
      }

      child.on("exit", markProcessExited);

      child.on("close", (exitCode, signal) => {
        markProcessExited(exitCode, signal);
        const result: JjCommandResult = {
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          truncated,
          exitCode,
          signal,
        };
        if (logger) {
          logger.trace(
            {
              provenance: context.provenance,
              durationMs: Date.now() - startedAt,
              exitCode,
              signal,
              truncated,
              stdoutBytes,
              stderrBytes,
            },
            "jj command closed",
          );
        }

        if (timeoutError) {
          return;
        }

        if (processError) {
          settle(() => reject(processError));
          return;
        }

        if (!truncated && !acceptExitCodes.includes(exitCode ?? -1)) {
          const stderrPreview = result.stderr.trim() || "(no stderr)";
          const truncationNote = result.truncated ? " (stdout truncated)" : "";
          settle(() =>
            reject(
              new Error(
                `jj command failed: ${command}${truncationNote} (exit code: ${String(exitCode)}, signal: ${signal ?? "none"}, provenance: ${context.provenance})\n${stderrPreview}`,
              ),
            ),
          );
          return;
        }

        settle(() => resolve(result));
      });
    });
    return { result: resultPromise, exited };
  };
  return context.scheduler().run(startCommand, { priority: context.priority() });
}

function formatJjCommand(args: string[]): string {
  return ["jj", ...JJ_GLOBAL_ARGS, ...args].join(" ");
}

export class InvalidJjFilesetPathError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Invalid path for jj fileset: ${JSON.stringify(path)} (${reason})`);
    this.name = "InvalidJjFilesetPathError";
  }
}

function assertValidJjFilesetPath(path: string): void {
  if (path.length === 0) {
    throw new InvalidJjFilesetPathError(path, "empty path");
  }
  if (path.includes("\0")) {
    throw new InvalidJjFilesetPathError(path, "NUL byte");
  }
  if (path.startsWith("/")) {
    throw new InvalidJjFilesetPathError(path, "absolute path; expected repo-relative");
  }
  if (/^[a-zA-Z]:/.test(path)) {
    throw new InvalidJjFilesetPathError(path, "drive-absolute path; expected repo-relative");
  }
  for (const segment of path.split(/[\\/]/)) {
    if (segment === "..") {
      throw new InvalidJjFilesetPathError(path, "parent traversal segment");
    }
  }
}

function escapeJjFilesetString(path: string): string {
  // Inside a double-quoted jj string literal only backslash and double quote
  // are escapes; everything else (tabs, newlines, unicode, glob metacharacters)
  // passes through as literal string content.
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build ONE jj fileset expression matching exactly the given repo-relative
 * paths.
 *
 * jj positional path arguments are FILESETS, not literals: a bare `a[1].txt`
 * parses as a prefix-glob with a character class and silently matches nothing
 * (verified against jj 0.45.1). `file:"path"` is the exact-match pattern kind,
 * so every path is emitted as `file:"<escaped>"` and combined with the union
 * operator. Paths are validated up front so a malformed path fails loudly here
 * instead of silently selecting the wrong (or no) files downstream.
 *
 * Use only for fileset argument positions (e.g. `jj diff -- <expr>`,
 * `jj restore -- <expr>`). Commands like `jj workspace add <dir>` take an
 * ordinary filesystem destination, not a fileset.
 */
export function literalJjFileset(paths: string[]): string {
  return paths.map((path) => validateAndQuote(path)).join(" | ");
}

function validateAndQuote(path: string): string {
  assertValidJjFilesetPath(path);
  return `file:"${escapeJjFilesetString(path)}"`;
}

/**
 * Convenience for commands that take `-- <fileset>`: returns null for an empty
 * path list so callers no-op instead of matching anything/everything.
 */
export function jjFilesetArg(paths: string[]): string[] | null {
  if (paths.length === 0) {
    return null;
  }
  return ["--", literalJjFileset(paths)];
}

const STALE_WORKING_COPY_PATTERN = /working copy is stale/i;

export interface StaleSafeJjRunResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
  exitCode: number | null;
}

/**
 * Run a jj command in a workspace directory, recovering once from a stale
 * working copy (the checked-out commit was rewritten from another workspace;
 * verified on 0.45.1: the failing command prints "Error: The working copy is
 * stale (not updated since operation …)" and `jj workspace update-stale`
 * resolves it). Exit-code semantics otherwise match the base executor:
 * accepted codes return, anything else throws with the original stderr.
 */
export async function runJjCommandStaleSafe(
  args: string[],
  options: { cwd: string; acceptExitCodes?: number[]; maxOutputBytes?: number },
  run: RunJjCommand = runJjCommand,
): Promise<StaleSafeJjRunResult> {
  // Explicit caller lists are preserved verbatim on the retry; only an ABSENT
  // list gets the executor's [0] default (review ND6).
  const explicitAccepted = options.acceptExitCodes;
  const accepted = explicitAccepted ?? [0];
  const first = await run(args, {
    cwd: options.cwd,
    acceptExitCodes: [...new Set([...accepted, 1, 2])],
    maxOutputBytes: options.maxOutputBytes,
  });
  if (first.exitCode === 0 || first.truncated) {
    // Truncated runs resolve like the base executor (output-cap kills); the
    // caller inspects `truncated`.
    return first;
  }
  if (STALE_WORKING_COPY_PATTERN.test(first.stderr)) {
    await run(["workspace", "update-stale"], { cwd: options.cwd });
    const second = await run(args, {
      cwd: options.cwd,
      ...(explicitAccepted ? { acceptExitCodes: explicitAccepted } : {}),
      maxOutputBytes: options.maxOutputBytes,
    });
    return {
      stdout: second.stdout,
      stderr: second.stderr,
      truncated: second.truncated,
      exitCode: second.exitCode,
    };
  }
  if (accepted.includes(first.exitCode ?? -1)) {
    return first;
  }
  throw new Error(
    `jj command failed: ${args.join(" ")} (exit ${first.exitCode}): ${first.stderr.trim()}`,
  );
}
