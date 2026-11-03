import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  InvalidJjFilesetPathError,
  createRunJjCommand,
  getJjProcessPolicy,
  configureJjProcessPolicy,
  jjFilesetArg,
  literalJjFileset,
  runJjCommand,
  withJjDeletionTransaction,
  JjMutationBarrierError,
} from "./run-jj-command";
import { createScratchJjRepo, isJjAvailable } from "../test-utils/jj";

const jjAvailable = isJjAvailable();

/**
 * Typed fake spawn adapter for executor edge cases that are not deterministic
 * against the real binary (timeout, output cap). Mirrors the ChildProcess
 * surface the executor consumes.
 */
class FakeJjProcess extends EventEmitter {
  public readonly pid = 4242;
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly stdin = new EventEmitter();
  public killed = false;

  public kill(signal: NodeJS.Signals = "SIGKILL"): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emitKill(signal);
    return true;
  }

  public emitKill(signal: NodeJS.Signals): void {
    queueMicrotask(() => {
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
    });
  }

  public emitExit(exitCode: number): void {
    queueMicrotask(() => {
      this.emit("exit", exitCode, null);
      this.emit("close", exitCode, null);
    });
  }
}

interface FakeSpawnPlan {
  exitCode?: number;
  stdout?: Buffer[] | string;
  neverExit?: boolean;
}

function fakeSpawn(plan: FakeSpawnPlan) {
  const processes: FakeJjProcess[] = [];
  const spawn: import("./run-jj-command.js").JjSpawnFn = (_command, _args, _options) => {
    const child = new FakeJjProcess();
    processes.push(child);
    if (plan.stdout) {
      const chunks = typeof plan.stdout === "string" ? [Buffer.from(plan.stdout)] : plan.stdout;
      queueMicrotask(() => {
        for (const chunk of chunks) {
          child.stdout.emit("data", chunk);
        }
      });
    }
    const plannedExitCode = plan.exitCode;
    if (!plan.neverExit && plannedExitCode !== undefined) {
      queueMicrotask(() => child.emitExit(plannedExitCode));
    }
    return child;
  };
  return { spawn, processes };
}

describe("runJjCommand", () => {
  describe.skipIf(!jjAvailable)("against a real jj binary", () => {
    let fixture: ReturnType<typeof createScratchJjRepo>;

    beforeEach(() => {
      fixture = createScratchJjRepo({ files: { "a.txt": "line\n", "src/b.txt": "b\n" } });
    });

    afterEach(() => {
      fixture.dispose();
    });

    it("resolves stdout for a successful command", async () => {
      const result = await runJjCommand(["root"], { cwd: fixture.repoDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(fixture.repoDir);
    });

    it("injects --color never so colored templates stay plain", async () => {
      // A template with explicit color would emit ANSI unless the executor's
      // global --color never wins.
      const result = await runJjCommand(
        [
          "log",
          "--no-graph",
          "-r",
          "@",
          "-T",
          'if(current_working_copy, label("wc", "WORKING_COPY"), "other") ++ "\\n"',
        ],
        { cwd: fixture.repoDir },
      );
      expect(result.stdout).toContain("WORKING_COPY");
      expect(result.stdout).not.toContain("\u001b[");
    });

    it("rejects with stderr preview on a non-accepted exit code", async () => {
      await expect(
        runJjCommand(["log", "-r", "no-such-revision-xyz"], { cwd: fixture.repoDir }),
      ).rejects.toThrow(
        /jj command failed:.*no-such-revision-xyz.*Revision `no-such-revision-xyz` doesn't exist/s,
      );
    });

    it("resolves non-zero exit codes listed in acceptExitCodes", async () => {
      // fixture.dir exists but has no .jj/.git ancestor within /tmp → not a repo.
      const result = await runJjCommand(["root"], {
        cwd: fixture.dir,
        acceptExitCodes: [1],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no jj repo");
    });

    it("passes a literal fileset through to a real diff", async () => {
      writeFileSync(join(fixture.repoDir, "new.txt"), "new\n");
      const arg = jjFilesetArg(["new.txt"]);
      expect(arg).not.toBeNull();
      const result = await runJjCommand(["diff", "--name-only", ...(arg ?? [])], {
        cwd: fixture.repoDir,
      });
      expect(result.stdout.trim()).toBe("new.txt");
    });
  });

  describe("executor edge cases (fake spawn adapter)", () => {
    it("times out and rejects when the process never exits", async () => {
      const { spawn, processes } = fakeSpawn({ neverExit: true });
      const run = createRunJjCommand("test", { spawn });
      const promise = run(["log"], { cwd: "/tmp", timeout: 20 });
      await expect(promise).rejects.toThrow("jj command timed out after 20ms");
      expect(processes[0]?.killed).toBe(true);
    });

    it("truncates stdout past maxOutputBytes, kills the process, and resolves truncated", async () => {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const { spawn, processes } = fakeSpawn({
        neverExit: true,
        stdout: [chunk, chunk, chunk, chunk],
      });
      const run = createRunJjCommand("test", { spawn });
      // Truncation resolves (mirroring run-git-command): the close handler's
      // exit-code rejection is gated on `!truncated`.
      const result = await run(["log"], { cwd: "/tmp", maxOutputBytes: 100 * 1024 });
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBe(100 * 1024);
      expect(processes[0]?.killed).toBe(true);
    });

    it("rejects when spawn throws synchronously", async () => {
      const spawn: import("./run-jj-command.js").JjSpawnFn = () => {
        throw new Error("ENOENT-ish");
      };
      const run = createRunJjCommand("test", { spawn });
      await expect(run(["root"], { cwd: "/tmp" })).rejects.toThrow("ENOENT-ish");
    });
  });

  describe("scheduler policy", () => {
    it("defaults to the git policy defaults", () => {
      configureJjProcessPolicy({});
      expect(getJjProcessPolicy()).toEqual({ maxProcessesPerSecond: 64, maxProcessConcurrency: 8 });
    });

    it("reads PASEO_JJ_MAX_* overrides", () => {
      configureJjProcessPolicy({
        PASEO_JJ_MAX_PROCESSES_PER_SECOND: "3",
        PASEO_JJ_MAX_PROCESS_CONCURRENCY: "2",
      });
      expect(getJjProcessPolicy()).toEqual({ maxProcessesPerSecond: 3, maxProcessConcurrency: 2 });
    });

    it("ignores invalid overrides", () => {
      configureJjProcessPolicy({ PASEO_JJ_MAX_PROCESS_CONCURRENCY: "zero" });
      expect(getJjProcessPolicy().maxProcessConcurrency).toBe(8);
    });
  });
});

describe("literalJjFileset", () => {
  it("quotes a plain path", () => {
    expect(literalJjFileset(["src/a.ts"])).toBe('file:"src/a.ts"');
  });

  it("unions multiple paths", () => {
    expect(literalJjFileset(["a.ts", "b.ts"])).toBe('file:"a.ts" | file:"b.ts"');
  });

  it("escapes backslash and double quote", () => {
    expect(literalJjFileset(['we"ird\\path'])).toBe('file:"we\\"ird\\\\path"');
  });

  it("rejects empty paths, NUL, absolute, and traversal", () => {
    expect(() => literalJjFileset([""])).toThrow(InvalidJjFilesetPathError);
    expect(() => literalJjFileset(["a\0b"])).toThrow(InvalidJjFilesetPathError);
    expect(() => literalJjFileset(["/etc/passwd"])).toThrow(InvalidJjFilesetPathError);
    expect(() => literalJjFileset(["C:\\repo\\a"])).toThrow(InvalidJjFilesetPathError);
    expect(() => literalJjFileset(["a/../b"])).toThrow(InvalidJjFilesetPathError);
  });

  it("returns null arg for an empty list (no-op contract)", () => {
    expect(jjFilesetArg([])).toBeNull();
    expect(jjFilesetArg(["a.ts"])).toEqual(["--", 'file:"a.ts"']);
  });

  describe.skipIf(!jjAvailable)("against a real jj binary (torture)", () => {
    let fixture: ReturnType<typeof createScratchJjRepo>;
    const weirdNames = [
      "a[1].txt",
      "weird*name.txt",
      'quo"te.txt',
      "sp ace.txt",
      "has#hash.txt",
      "back\\slash.txt",
      "tab\tname.txt",
      "q?mark.txt",
      "paren(open).txt",
      "pipe|or.txt",
      "glob:sneaky.txt",
      "brace{e}.txt",
      "new\nline.txt",
    ];

    beforeEach(() => {
      const files: Record<string, string> = {};
      for (const name of weirdNames) {
        files[name] = "x\n";
      }
      files["plain.txt"] = "x\n";
      fixture = createScratchJjRepo({ files });
      // The fixture committed everything as the initial change (@ is now empty);
      // rewrite each file so @'s diff actually contains them.
      for (const name of [...weirdNames, "plain.txt"]) {
        writeFileSync(join(fixture.repoDir, name), "y\n");
      }
    });

    afterEach(() => {
      fixture.dispose();
    });

    async function diffNamesFor(filesetArg: string[] | null): Promise<string[]> {
      expect(filesetArg).not.toBeNull();
      const result = await runJjCommand(["diff", "--name-only", ...(filesetArg ?? [])], {
        cwd: fixture.repoDir,
      });
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    async function diffRawFor(filesetArg: string[] | null): Promise<string> {
      expect(filesetArg).not.toBeNull();
      const result = await runJjCommand(["diff", "--name-only", ...(filesetArg ?? [])], {
        cwd: fixture.repoDir,
      });
      return result.stdout.trim();
    }

    for (const name of weirdNames) {
      it(`matches ${JSON.stringify(name)} exactly`, async () => {
        // A filename containing a newline spans lines; compare raw output.
        if (name.includes("\n")) {
          expect(await diffRawFor(jjFilesetArg([name]))).toBe(name);
          return;
        }
        const names = await diffNamesFor(jjFilesetArg([name]));
        expect(names).toEqual([name]);
      });
    }

    it("matches the union of several weird names", async () => {
      const names = await diffNamesFor(jjFilesetArg(["a[1].txt", "sp ace.txt", "brace{e}.txt"]));
      expect(names.sort()).toEqual(["a[1].txt", "brace{e}.txt", "sp ace.txt"].sort());
    });

    it("matches a path in a subdirectory", async () => {
      const nested = join(fixture.repoDir, "nested");
      mkdirSync(nested);
      writeFileSync(join(nested, "in[ner].txt"), "y\n");
      const names = await diffNamesFor(jjFilesetArg(["nested/in[ner].txt"]));
      expect(names).toEqual(["nested/in[ner].txt"]);
    });

    it("documents the hazard: an unescaped bare bracket path silently matches nothing", async () => {
      // This is why literalJjFileset exists. If jj ever makes bare paths
      // literal, this test flips and the helper still stays correct.
      const names = await diffNamesFor(["--", "a[1].txt"]);
      expect(names).toEqual([]);
    });
  });
});

describe("jj deletion barrier", () => {
  it("drains an in-flight command before starting deletion and rejects overlapping deletions", async () => {
    const { spawn, processes } = fakeSpawn({ neverExit: true });
    const run = createRunJjCommand("barrier-drain", { spawn });
    const events: string[] = [];
    const command = run(["describe", "-m", "in flight"], { cwd: "/tmp/barrier-drain" });
    const deletion = withJjDeletionTransaction("/tmp/barrier-drain", async () => {
      events.push("deletion");
    });
    await expect(
      withJjDeletionTransaction("/tmp/barrier-drain", async () => {}),
    ).rejects.toBeInstanceOf(JjMutationBarrierError);
    await expect(run(["log"], { cwd: "/tmp/barrier-drain/subdir" })).rejects.toBeInstanceOf(
      JjMutationBarrierError,
    );
    expect(events).toEqual([]);
    expect(processes).toHaveLength(1);
    events.push("exit");
    processes[0]!.emitExit(0);
    await command;
    await deletion;
    expect(events).toEqual(["exit", "deletion"]);
  });

  it("permits the deletion's own commands but does not exempt a second workspace", async () => {
    const { spawn } = fakeSpawn({ exitCode: 0 });
    const run = createRunJjCommand("barrier-own", { spawn });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = withJjDeletionTransaction("/tmp/barrier-other", () => gate);
    await withJjDeletionTransaction("/tmp/barrier-own", async () => {
      await run(["status"], { cwd: "/tmp/barrier-own" });
      await expect(
        run(["describe", "-m", "wrong root"], { cwd: "/tmp/barrier-other" }),
      ).rejects.toBeInstanceOf(JjMutationBarrierError);
    });
    release();
    await other;
  });
});

describe("jj command cancellation", () => {
  it("refuses an already aborted command before spawning", async () => {
    const controller = new AbortController();
    const reason = new Error("closed observation");
    controller.abort(reason);
    const fake = fakeSpawn({ neverExit: true });
    const run = createRunJjCommand("cancelled-fetch", { spawn: fake.spawn });
    await expect(run(["git", "fetch"], { cwd: "/tmp", signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(fake.processes).toEqual([]);
  });

  it("kills a cancelled child and retains the deletion barrier until actual exit", async () => {
    class DelayedCancelledProcess extends FakeJjProcess {
      public emitKill(): void {}
    }
    const child = new DelayedCancelledProcess();
    let didSpawn = () => {};
    const spawned = new Promise<void>((resolve) => {
      didSpawn = resolve;
    });
    const run = createRunJjCommand("cancelled-running-fetch", {
      spawn: () => {
        didSpawn();
        return child;
      },
    });
    const controller = new AbortController();
    const reason = new Error("observation closed");
    const pending = run(["git", "fetch"], {
      cwd: "/tmp/cancelled-jj-workspace",
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await spawned;
    controller.abort(reason);
    expect(child.killed).toBe(true);
    let enteredDeletion = false;
    const deletion = withJjDeletionTransaction("/tmp/cancelled-jj-workspace", async () => {
      enteredDeletion = true;
    });
    await Promise.resolve();
    expect(enteredDeletion).toBe(false);
    child.emitExit(0);
    await rejected;
    await deletion;
    expect(enteredDeletion).toBe(true);
  });

  it.each([false, true])(
    "timeout with signal-owned lifetime=%s preserves its result/exit contract",
    async (owned) => {
      let killed = () => {};
      const didKill = new Promise<void>((resolve) => {
        killed = resolve;
      });
      class DelayedTimeoutProcess extends FakeJjProcess {
        public emitKill(): void {
          killed();
        }
      }
      const child = new DelayedTimeoutProcess();
      const run = createRunJjCommand("timeout-lifetime", { spawn: () => child });
      const controller = new AbortController();
      const pending = run(["git", "fetch"], {
        cwd: `/tmp/jj-timeout-lifetime-${owned}`,
        timeout: 5,
        ...(owned ? { signal: controller.signal } : {}),
      });
      const rejected = expect(pending).rejects.toThrow("timed out after 5ms");
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      try {
        await didKill;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(!owned);
        controller.abort(new Error("closed observation after timeout"));
        child.emitExit(0);
        await rejected;
        expect(settled).toBe(true);
      } finally {
        child.emitExit(0);
        await pending.catch(() => {});
      }
    },
  );
});
