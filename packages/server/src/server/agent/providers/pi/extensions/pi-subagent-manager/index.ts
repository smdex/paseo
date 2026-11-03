import { z } from "zod";
import type { ProviderSubagentInputEvent } from "../../../../provider-subagents/store.js";
import type { PiChildSessionFile, PiExtension, PiExtensionCustomMapping } from "../contract.js";
import { MANAGER_SNAPSHOT_MARKER, managerRuntimeBridge } from "./runtime-bridge.js";

const threadPath = z
  .string()
  .max(1024)
  .regex(/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/);
const snapshotSchema = z.object({
  version: z.literal(1),
  rootSessionId: z.string().min(1).max(256),
  generation: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  threads: z
    .array(
      z.object({
        id: z.string().min(1).max(2048),
        path: threadPath,
        parent: threadPath.nullable(),
        state: z.enum(["starting", "running", "completed", "paused", "stopped", "failed"]),
        type: z.string().max(1024),
        task: z.string().max(128 * 1024),
        status: z.string().max(128 * 1024),
        model: z.string().max(1024).optional(),
        thinkingLevel: z.string().max(64).optional(),
        createdAt: z.number().nonnegative().max(8.64e15),
        updatedAt: z.number().nonnegative().max(8.64e15),
        sessionFile: z.string().min(1).max(8192).optional(),
        sessionLeafId: z.string().max(256).nullable().optional(),
      }),
    )
    .max(512),
});

type Snapshot = z.infer<typeof snapshotSchema>;
function childId(session: string, thread: string): string {
  return `pi-subagent-manager:${JSON.stringify([session, thread])}`;
}

const status = {
  starting: "running",
  running: "running",
  completed: "completed",
  paused: "completed",
  stopped: "canceled",
  failed: "failed",
} as const;

function mapSnapshot(snapshot: Snapshot): PiExtensionCustomMapping {
  const subagents: ProviderSubagentInputEvent[] = [];
  const childSessions: PiChildSessionFile[] = [];
  const paths = new Map(snapshot.threads.map((thread) => [thread.path, thread.id]));
  for (const thread of snapshot.threads) {
    const id = childId(snapshot.rootSessionId, thread.id);
    subagents.push({
      type: "upsert",
      id,
      parentSubagentId:
        thread.parent && thread.parent !== "/root"
          ? childId(snapshot.rootSessionId, paths.get(thread.parent)!)
          : null,
      title: thread.path,
      description: thread.task,
      status: status[thread.state],
      subtitle: [
        thread.state === "paused" ? "Paused · no final answer" : thread.state,
        thread.type,
        thread.model,
        thread.thinkingLevel,
        thread.status,
      ]
        .filter(Boolean)
        .join(" · "),
      timestamp: new Date(thread.updatedAt).toISOString(),
    });
    if (thread.sessionFile && thread.sessionLeafId !== undefined) {
      childSessions.push({
        id,
        file: thread.sessionFile,
        branch: { leafId: thread.sessionLeafId, skipInherited: true },
      });
    }
  }
  return { subagents, childSessions };
}

export const piSubagentManager: PiExtension = {
  id: "pi-subagent-manager",
  runtimeBridge: managerRuntimeBridge,
  createSession() {
    let current: Snapshot | undefined;
    return {
      snapshot: () => (current ? mapSnapshot(current) : { subagents: [] }),
      mapRuntimeNotification(message) {
        if (!message.startsWith(`${MANAGER_SNAPSHOT_MARKER} `)) return undefined;
        // Claim malformed/unsupported observations without displaying their raw JSON as chat.
        if (message.length > 8 * 1024 * 1024) return { subagents: [] };
        let payload: unknown;
        try {
          payload = JSON.parse(message.slice(MANAGER_SNAPSHOT_MARKER.length + 1));
        } catch {
          return { subagents: [] };
        }
        const parsed = snapshotSchema.safeParse(payload);
        if (!parsed.success) return { subagents: [] };
        const next = parsed.data;
        if (
          current &&
          (next.generation < current.generation ||
            (next.generation === current.generation &&
              (next.rootSessionId !== current.rootSessionId || next.revision <= current.revision)))
        ) {
          return { subagents: [] };
        }
        const paths = new Set(next.threads.map((thread) => thread.path));
        if (
          paths.size !== next.threads.length ||
          new Set(next.threads.map((thread) => thread.id)).size !== next.threads.length ||
          next.threads.some(
            (thread) =>
              thread.path === "/root" ||
              (thread.parent !== null && thread.parent !== "/root" && !paths.has(thread.parent)) ||
              thread.parent !==
                (thread.path.lastIndexOf("/") === 0
                  ? null
                  : thread.path.slice(0, thread.path.lastIndexOf("/"))),
          )
        ) {
          return { subagents: [] };
        }
        const mapping = mapSnapshot(next);
        const retained = new Set(mapping.subagents.map((event) => event.id));
        const removed: ProviderSubagentInputEvent[] = current
          ? mapSnapshot(current)
              .subagents.filter((event) => !retained.has(event.id))
              .map(({ id }) => ({ type: "remove", id }))
          : [];
        current = next;
        return { ...mapping, subagents: [...removed, ...mapping.subagents] };
      },
    };
  },
};
