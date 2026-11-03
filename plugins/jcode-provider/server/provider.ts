import { randomUUID } from "node:crypto";
import { execCommand } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { readCatalog } from "./catalog.js";
import { Connection } from "./connection.js";
import { Session } from "./session.js";
import { JcodeError, persistenceSchema, sessionsSchema } from "./wire.js";

const capabilities = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.persistence",
  "session.list",
  "session.archive",
  "session.unarchive",
  "session.subsession",
  "tools.paseo.native",
] as const;

export function createJcodeProvider(): ProviderRegistration {
  return {
    id: "jcode",
    label: "Jcode",
    description: "Native Jcode sessions on your local development host",
    icon: "icon.svg",
    command: ["jcode"],
    async status({ launch }) {
      if (!launch)
        return { available: false, diagnostic: "Install Jcode and ensure `jcode` is on PATH." };
      try {
        const { stdout } = await execCommand(
          launch.command,
          [...launch.args, "--quiet", "--no-update", "api-bridge", "--help"],
          { env: launch.env, timeout: 5000, maxBuffer: 32768 },
        );
        if (!stdout.includes("--stdio"))
          return {
            available: false,
            diagnostic: "Update Jcode to a version supporting api-bridge --stdio.",
          };
        return { available: true };
      } catch (error) {
        return {
          available: false,
          diagnostic: `Cannot start Jcode's native transport: ${String(error)}`,
        };
      }
    },
    async connect(request) {
      if (!request.versions.includes(1))
        throw new JcodeError(
          "unsupported_version",
          "Jcode provider requires Paseo provider protocol v1",
        );
      if (!request.launch)
        throw new JcodeError("missing_launch", "Jcode requires a daemon-resolved executable");
      return connect(
        request.launch,
        negotiateProviderCapabilities(request.capabilities, capabilities),
      );
    },
  };
}

function connect(launch: ProviderLaunch, negotiated: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  const parents = new Map<string, string>();
  const operations = new Set<Promise<void>>();
  let closing = false;
  let scanning = false;
  let closePromise: Promise<void> | null = null;
  function emit(event: ProviderEvent): void {
    for (const listener of listeners) listener(event);
  }
  function session(id: string): Session {
    const value = sessions.get(id);
    if (!value) throw new JcodeError("unknown_session", `Jcode session ${id} is not open`);
    return value;
  }
  function requireLiveParent(id: string): void {
    if (closing || !sessions.has(id))
      throw new JcodeError("closed", "Jcode parent session closed during worker discovery");
  }
  async function withHost<T>(callback: (host: Connection) => Promise<T>): Promise<T> {
    const host = new Connection(launch);
    try {
      await host.initialize();
      return await callback(host);
    } finally {
      await host.close();
    }
  }
  async function discover(): Promise<void> {
    if (closing || scanning || !sessions.size) return;
    scanning = true;
    try {
      const root = sessions.values().next().value;
      if (!root) return;
      const native = await root.host.request("list_sessions", {}, sessionsSchema);
      let added = true;
      while (added) {
        added = false;
        for (const child of native.sessions) {
          if (closing) break;
          if (!child.parent_session_id) continue;
          if ([...sessions.values()].some((value) => value.native?.session_id === child.session_id))
            continue;
          const parent = [...sessions.values()].find(
            (value) => value.native?.session_id === child.parent_session_id,
          );
          if (!parent) continue;
          const id = `jcode-child:${child.session_id}:${randomUUID()}`;
          const childSession = new Session(id, new Connection(launch, child.working_dir), emit);
          sessions.set(id, childSession);
          parents.set(id, parent.id);
          try {
            // Swarm workers retain their native tool policy. Attaching never replaces it.
            await childSession.openChild(
              child,
              parent.id,
              negotiated.filter((capability) => capability !== "tools.paseo.native"),
            );
            requireLiveParent(parent.id);
            added = true;
          } catch (error) {
            sessions.delete(id);
            parents.delete(id);
            await childSession.close().catch(() => {});
            emit({
              type: "session.notice",
              sessionId: parent.id,
              notice: {
                id: `jcode-child:${child.session_id}`,
                severity: "warning",
                title: "Could not attach Jcode worker",
                description: String(error),
              },
            });
          }
        }
      }
    } catch (error) {
      const root = sessions.values().next().value;
      if (root && !closing)
        emit({
          type: "session.notice",
          sessionId: root.id,
          notice: {
            id: "jcode-children",
            severity: "warning",
            title: "Jcode worker discovery failed",
            description: String(error),
          },
        });
    } finally {
      scanning = false;
    }
  }
  const scanTimer = setInterval(() => track(discover()), 1500);
  scanTimer.unref();
  function track(operation: Promise<void>): void {
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => {});
  }
  async function closeSession(id: string): Promise<void> {
    const value = session(id);
    sessions.delete(id);
    parents.delete(id);
    const results = await Promise.allSettled([
      ...[...parents]
        .filter(([, parentId]) => parentId === id)
        .map(([childId]) => closeSession(childId)),
      value.close(),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: await readCatalog(launch, input.cwd),
        });
        return;
      case "sessions": {
        const native = await withHost((host) => host.request("list_sessions", {}, sessionsSchema));
        const query = input.query?.toLowerCase();
        const rows = native.sessions
          .filter(
            (row) =>
              (!input.cwd || row.working_dir === input.cwd) &&
              (!query || `${row.title ?? ""} ${row.session_id}`.toLowerCase().includes(query)),
          )
          .slice(0, input.limit)
          .map((row) => {
            const timestamp = row.last_active_at_ms ?? row.updated_at_ms;
            return {
              id: row.session_id,
              persistence: { version: 1, data: { sessionId: row.session_id } },
              cwd: row.working_dir ?? "",
              title: row.title,
              description: row.agent_label,
              updatedAt: timestamp === undefined ? undefined : new Date(timestamp).toISOString(),
            };
          });
        emit({ type: "sessions", requestId: input.requestId, sessions: rows });
        return;
      }
      case "session.open": {
        await openSession(input);
        track(discover());
        return;
      }
      case "session.prompt":
        await session(input.sessionId).prompt(input.prompt);
        return;
      case "session.interrupt":
        await session(input.sessionId).interrupt();
        break;
      case "session.configure":
        await session(input.sessionId).configure(input.changes);
        break;
      case "session.tool_result":
        await session(input.sessionId).toolResult(input);
        return;
      case "session.close":
        await closeSession(input.sessionId);
        break;
      case "session.archive":
      case "session.unarchive": {
        if (input.persistence.version !== 1)
          throw new JcodeError("invalid_persistence", "Unknown Jcode persistence version");
        const native = persistenceSchema.parse(input.persistence.data);
        await withHost((host) =>
          host.request(
            input.type === "session.archive" ? "archive_session" : "restore_session",
            { session_id: native.sessionId },
            z.object({ ev: z.literal("ok") }),
          ),
        );
        break;
      }
      case "session.permission":
        throw new JcodeError("unsupported", "Jcode's native harness does not expose permissions");
      case "session.revert":
        throw new JcodeError(
          "unsupported",
          "Jcode's native history lacks safe durable rewind identities",
        );
    }
    if ("requestId" in input) emit({ type: "request.completed", requestId: input.requestId });
  }
  async function openSession(
    input: Extract<ProviderInput, { type: "session.open" }>,
  ): Promise<void> {
    if (sessions.has(input.sessionId))
      throw new JcodeError("duplicate_session", "Jcode session is already open");
    const value = new Session(input.sessionId, new Connection(launch, input.config.cwd), emit);
    sessions.set(input.sessionId, value);
    try {
      await value.open(input, negotiated);
    } catch (error) {
      sessions.delete(input.sessionId);
      try {
        if (
          !input.persistence &&
          value.native &&
          value.host.capabilities.includes("session_archive")
        )
          await value.host.request(
            "archive_session",
            { session_id: value.native.session_id },
            z.object({ ev: z.literal("ok") }),
          );
      } catch {
        // Keep the setup error. Include the native session ID for manual recovery below.
      } finally {
        await value.host.close().catch(() => {});
      }
      if (!input.persistence && value.native)
        throw new JcodeError(
          "session_setup_failed",
          `${String(error)} (native session ${value.native.session_id})`,
        );
      throw error;
    }
  }
  async function send(input: ProviderInput): Promise<void> {
    if (closing) throw new JcodeError("closed", "Jcode provider is closing");
    try {
      requireProviderCapabilities(negotiated, input);
      await dispatch(input);
    } catch (error) {
      const diagnostic =
        error instanceof JcodeError ? error : new JcodeError("provider_error", String(error));
      if (input.type === "session.prompt")
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "failed", error: diagnostic },
        });
      else if ("requestId" in input)
        emit({ type: "request.failed", requestId: input.requestId, error: diagnostic });
      else throw diagnostic;
    }
  }
  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      const operation = send(input);
      track(operation);
      await operation;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(scanTimer);
      closePromise = (async () => {
        await Promise.allSettled(operations);
        const results = await Promise.allSettled(
          [...sessions.values()].map((value) => value.close()),
        );
        const failed = results.find((result) => result.status === "rejected");
        sessions.clear();
        parents.clear();
        listeners.clear();
        if (failed?.status === "rejected") throw failed.reason;
      })();
      return closePromise;
    },
  };
}
