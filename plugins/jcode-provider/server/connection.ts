import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import type { z } from "zod";
import { envelopeSchema, helloSchema, JcodeError, type NativeFrame } from "./wire.js";

interface PendingRequest {
  resolve(frame: NativeFrame): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class Connection {
  private readonly child;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(frame: NativeFrame) => void>();
  private readonly failures = new Set<(error: JcodeError) => void>();
  private sequence = 0;
  private messageRequest: number | null = null;
  private buffer = "";
  private stderr = "";
  private failure: JcodeError | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly exited: Promise<void>;
  private attached: string | null = null;
  capabilities: readonly string[] = [];

  constructor(launch: ProviderLaunch, cwd?: string) {
    this.child = spawnProcess(
      launch.command,
      [...launch.args, "--quiet", "--no-update", "api-bridge", "--stdio"],
      { env: launch.env, cwd, stdio: "pipe" },
    );
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      try {
        this.receive(chunk);
      } catch (error) {
        this.fail(new JcodeError("invalid_frame", `Invalid Jcode harness frame: ${String(error)}`));
        void this.close().catch(() => {});
      }
    });
    this.child.stdin.on("error", (error) =>
      this.fail(new JcodeError("disconnected", error.message)),
    );
    this.child.on("error", (error) => this.fail(new JcodeError("spawn_failed", error.message)));
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.fail(
          new JcodeError("disconnected", `Jcode bridge closed (${signal ?? code}): ${this.stderr}`),
        );
        resolve();
      });
    });
  }

  async initialize(): Promise<void> {
    const hello = await this.request(
      "hello",
      { min_version: 1, max_version: 1, client: "paseo" },
      helloSchema,
    );
    const required = [
      "sessions",
      "streaming",
      "text_framing",
      "turn_stop_reasons",
      "persisted_session_discovery",
      "runtime_info",
    ];
    for (const capability of required) {
      if (!hello.capabilities.includes(capability))
        throw new JcodeError("unsupported", `Update Jcode: native provider requires ${capability}`);
    }
    this.capabilities = hello.capabilities;
  }

  onEvent(listener: (frame: NativeFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onFailure(listener: (error: JcodeError) => void): () => void {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }
  async request<T>(
    req: string,
    fields: object,
    schema: z.ZodType<T>,
    timeoutMs = 30000,
  ): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.closePromise) throw new JcodeError("closed", "Jcode bridge is closing");
    if (req === "send_message" && this.messageRequest !== null)
      throw new JcodeError("busy", "Jcode message admission is already pending");
    const id = ++this.sequence;
    if (req === "send_message") this.messageRequest = id;
    const frame = await new Promise<NativeFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new JcodeError(
          "timeout",
          `Jcode ${req} timed out after ${timeoutMs}ms. The operation's outcome is unknown.`,
        );
        if (req === "send_message" || req === "configure_tools") {
          // Admission has no correlation ID. A late acknowledgement must never admit a later prompt.
          this.fail(error);
          void this.close().catch(() => {});
        } else {
          this.pending.delete(id);
          reject(error);
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ v: 1, id, req, ...fields })}\n`, (error) => {
        if (error) this.fail(new JcodeError("disconnected", error.message));
      });
    });
    const result = schema.parse(frame);
    if (frame.ev === "attached") {
      const session = frame.session;
      if (
        typeof session === "object" &&
        session !== null &&
        "session_id" in session &&
        typeof session.session_id === "string"
      )
        this.attached = session.session_id;
    }
    if (req === "detach_session") this.attached = null;
    return result;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Set the promise after beginning detach, since request refuses new work once closing.
    this.closePromise = this.finishClose();
    return this.closePromise;
  }
  private async finishClose(): Promise<void> {
    let detachError: unknown;
    try {
      if (this.attached && !this.failure)
        await this.request("detach_session", { session_id: this.attached }, envelopeSchema, 3000);
    } catch (error) {
      detachError = error;
    }
    this.child.stdin.end();
    const closed = await this.waitForExit(1000);
    if (!closed) {
      // Own only this stdio bridge. The shared daemon is detached and never terminated here.
      terminateProcess(this.child);
      if (!(await this.waitForExit(1000))) {
        this.child.kill("SIGKILL");
        if (!(await this.waitForExit(1000)))
          throw new JcodeError("close_failed", "Jcode bridge did not exit after termination");
      }
    }
    if (detachError) throw detachError;
  }
  private async waitForExit(milliseconds: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    // Match the harness's bounded framing, including complete oversized lines.
    if (Buffer.byteLength(this.buffer) > 64 * 1024 * 1024)
      throw new JcodeError("frame_too_large", "Jcode frame exceeds 64 MiB");
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      const frame = envelopeSchema.parse(JSON.parse(line));
      let replyTo = frame.reply_to;
      // send_message acceptance is intentionally uncorrelated in harness v1.
      if (frame.ev === "message_accepted") replyTo = this.messageRequest ?? undefined;
      if (replyTo !== undefined) {
        const pending = this.pending.get(replyTo);
        if (pending) {
          this.pending.delete(replyTo);
          if (replyTo === this.messageRequest) this.messageRequest = null;
          clearTimeout(pending.timer);
          if (frame.ev === "error")
            pending.reject(new JcodeError(String(frame.code), String(frame.message)));
          else pending.resolve(frame);
        }
      }
      if (frame.ev === "error" && replyTo === undefined) {
        this.fail(new JcodeError(String(frame.code), String(frame.message)));
      }
      for (const listener of this.listeners) listener(frame);
    }
  }
  private fail(diagnostic: JcodeError): void {
    if (this.failure) return;
    this.failure = diagnostic;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(diagnostic);
    }
    this.pending.clear();
    this.messageRequest = null;
    if (!this.closePromise) for (const listener of this.failures) listener(diagnostic);
    void this.close().catch(() => {});
  }
}
