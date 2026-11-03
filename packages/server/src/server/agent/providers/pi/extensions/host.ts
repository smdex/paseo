import type { Logger } from "pino";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentStreamEvent,
} from "../../../agent-sdk-types.js";
import type { PiAgentMessage } from "../rpc-types.js";
import { mapPiChildSession, PiChildSessionFollower } from "./child-session.js";
import type {
  PiExtension,
  PiExtensionCustomMapping,
  PiExtensionDialog,
  PiExtensionDialogMapping,
  PiExtensionSession,
  PiExtensionToolCall,
  PiExtensionToolMapping,
  PiExtensionUiReply,
} from "./contract.js";

export type PiExtensionOutput<T> = T & {
  events: AgentStreamEvent[];
  hydration: Promise<AgentStreamEvent[]>;
};
export type PiExtensionEventOutput = PiExtensionOutput<
  PiExtensionToolMapping | PiExtensionCustomMapping
>;

interface Session {
  id: string;
  adapter: PiExtensionSession;
}

interface Follower {
  reader: PiChildSessionFollower;
  /** Reads run in order so a final read cannot overtake a tick. */
  pending: Promise<void>;
  active: boolean;
  retained: boolean;
  reading?: boolean;
  descriptor?: Extract<
    import("../../../provider-subagents/store.js").ProviderSubagentInputEvent,
    { type: "upsert" }
  >;
}

export class PiExtensionHost {
  private readonly sessions: Session[] = [];
  private remainingHydrationBytes: number;
  private readonly followers = new Map<string, Follower>();
  private onFollowEvent?: (event: AgentStreamEvent) => void;
  private followTimer?: ReturnType<typeof setInterval>;
  private pollingExtensions = false;

  constructor(
    extensions: readonly PiExtension[],
    private readonly logger?: Pick<Logger, "warn">,
    hydrationByteBudget = Number.POSITIVE_INFINITY,
    private readonly readChildSession: typeof mapPiChildSession = mapPiChildSession,
  ) {
    this.remainingHydrationBytes = hydrationByteBudget;
    for (const extension of extensions) {
      const adapter = this.safe(extension.id, "createSession", () => extension.createSession());
      if (adapter) this.sessions.push({ id: extension.id, adapter });
    }
  }

  /** Live sessions follow child files and adapter polls; replay hosts read each file once. */
  follow(onEvent: (event: AgentStreamEvent) => void): void {
    this.onFollowEvent = onEvent;
    this.followTimer ??= setInterval(() => {
      for (const [id, follower] of this.followers) {
        if (follower.active) void this.readFollower(id, follower, true);
      }
      void this.pollExtensions();
    }, 250);
  }

  close(): void {
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = undefined;
    this.onFollowEvent = undefined;
    this.followers.clear();
    this.sessions.length = 0;
  }

  private readFollower(id: string, follower: Follower, coalesce = false): Promise<void> {
    // Lifecycle reads must see bytes appended after an in-flight periodic read captured its size.
    if (coalesce && follower.reading) return follower.pending;
    follower.reading = true;
    const pending = follower.pending
      .then(async () => {
        if (this.followers.get(id) !== follower || !this.onFollowEvent) return;
        const events = await follower.reader.readNew();
        if (this.followers.get(id) !== follower || !this.onFollowEvent) return;
        if (follower.reader.reset && follower.descriptor) {
          this.onFollowEvent({
            type: "provider_subagent",
            provider: "pi",
            event: { type: "remove", id },
          });
          this.onFollowEvent({
            type: "provider_subagent",
            provider: "pi",
            event: follower.descriptor,
          });
        }
        for (const event of events) {
          this.onFollowEvent?.({ type: "provider_subagent", provider: "pi", event });
        }
        return undefined;
      })
      .catch((error) => {
        this.logger?.warn(
          { err: error, operation: "follow", childId: id },
          "Pi child follow failed",
        );
      })
      .finally(() => {
        if (follower.pending === pending) follower.reading = false;
      });
    follower.pending = pending;
    return pending;
  }

  private async pollExtensions(): Promise<void> {
    if (this.pollingExtensions || !this.onFollowEvent) return;
    this.pollingExtensions = true;
    try {
      for (const { id, adapter } of this.sessions) {
        const mapping = this.safe(id, "poll", () => adapter.poll?.());
        if (!mapping) continue;
        const output = this.prepare(id, mapping);
        for (const event of output.events) this.onFollowEvent?.(event);
        for (const event of await output.hydration) this.onFollowEvent?.(event);
      }
    } finally {
      this.pollingExtensions = false;
    }
  }

  private safe<T>(id: string, operation: string, call: () => T): T | undefined {
    try {
      return call();
    } catch (error) {
      this.logger?.warn({ err: error, extensionId: id, operation }, "Pi extension adapter failed");
      return undefined;
    }
  }

  mapToolCall(call: PiExtensionToolCall): PiExtensionOutput<PiExtensionToolMapping> | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapToolCall", () => adapter.mapToolCall?.(call));
      if (mapping) {
        const prepared = this.safe(id, "prepare", () => this.prepare(id, mapping));
        if (prepared) return prepared;
      }
    }
    return undefined;
  }

  mapCustomMessage(
    message: Extract<PiAgentMessage, { role: "custom" }>,
  ): PiExtensionOutput<PiExtensionCustomMapping> | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapCustomMessage", () => adapter.mapCustomMessage?.(message));
      if (mapping) {
        const prepared = this.safe(id, "prepare", () => this.prepare(id, mapping));
        if (prepared) return prepared;
      }
    }
    return undefined;
  }

  mapRuntimeNotification(message: string): PiExtensionOutput<PiExtensionCustomMapping> | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapRuntimeNotification", () =>
        adapter.mapRuntimeNotification?.(message),
      );
      if (mapping) {
        const prepared = this.safe(id, "prepare", () => this.prepare(id, mapping));
        if (prepared) return prepared;
      }
    }
    return undefined;
  }

  private prepare<T extends PiExtensionToolMapping | PiExtensionCustomMapping>(
    id: string,
    mapping: T,
  ): PiExtensionOutput<T> {
    const events: AgentStreamEvent[] = [
      ...("timeline" in mapping ? (mapping.timeline ?? []) : []).map(
        (item): AgentStreamEvent => ({ type: "timeline", provider: "pi", item }),
      ),
      ...(mapping.subagents ?? []).map(
        (event): AgentStreamEvent => ({ type: "provider_subagent", provider: "pi", event }),
      ),
    ];
    const hydration = (
      this.onFollowEvent ? this.followChildren(mapping) : this.readChildren(mapping)
    ).catch((error): AgentStreamEvent[] => {
      this.logger?.warn(
        { err: error, extensionId: id, operation: "hydrate" },
        "Pi extension adapter failed",
      );
      return [];
    });
    return { ...mapping, events, hydration };
  }

  private async followChildren(
    mapping: PiExtensionToolMapping | PiExtensionCustomMapping,
  ): Promise<AgentStreamEvent[]> {
    for (const child of mapping.childSessions ?? []) {
      const previous = this.followers.get(child.id);
      if (!previous || previous.reader.file !== child.file) {
        this.followers.set(child.id, {
          reader: new PiChildSessionFollower(child.id, child.file, undefined, child.branch),
          pending: Promise.resolve(),
          active: true,
          retained: Boolean(child.branch),
        });
      } else previous.reader.setBranch(child.branch);
    }
    for (const event of mapping.subagents ?? []) {
      if (event.type === "remove") this.followers.delete(event.id);
      const follower = this.followers.get(event.id);
      if (follower && event.type === "upsert") {
        follower.descriptor = event;
        if (event.status) follower.active = event.status === "running";
      }
    }
    const finished = (mapping.subagents ?? []).flatMap((event) =>
      event.type === "upsert" && event.status && event.status !== "running" ? [event.id] : [],
    );
    const reads = [
      ...new Set([...(mapping.childSessions ?? []).map(({ id }) => id), ...finished]),
    ].flatMap((id) => {
      const follower = this.followers.get(id);
      return follower ? [this.readFollower(id, follower)] : [];
    });
    await Promise.all(reads);
    for (const id of finished) {
      const follower = this.followers.get(id);
      if (follower && !follower.active && !follower.retained) this.followers.delete(id);
    }
    return [];
  }

  /** Rebuild observed child stores from the same cursors; replays never append a second copy. */
  async snapshot(): Promise<AgentStreamEvent[]> {
    await Promise.all([...this.followers.values()].map((follower) => follower.pending));
    const events: AgentStreamEvent[] = [];
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "snapshot", () => adapter.snapshot?.());
      for (const event of mapping?.subagents ?? []) {
        if (event.type !== "upsert") continue;
        events.push(
          { type: "provider_subagent", provider: "pi", event: { type: "remove", id: event.id } },
          { type: "provider_subagent", provider: "pi", event },
          ...(this.followers.get(event.id)?.reader.snapshot() ?? []).map(
            (childEvent): AgentStreamEvent => ({
              type: "provider_subagent",
              provider: "pi",
              event: childEvent,
            }),
          ),
        );
      }
    }
    return events;
  }

  private async readChildren(
    mapping: PiExtensionToolMapping | PiExtensionCustomMapping,
  ): Promise<AgentStreamEvent[]> {
    const groups = await Promise.all(
      (mapping.childSessions ?? []).map(async ({ id, file, branch }) => {
        const bytes = Math.min(this.remainingHydrationBytes, 2 * 1024 * 1024);
        if (bytes <= 0) return [];
        this.remainingHydrationBytes -= bytes;
        const events = await (branch
          ? this.readChildSession(id, file, bytes, branch)
          : this.readChildSession(id, file, bytes));
        return events.map(
          (event): AgentStreamEvent => ({ type: "provider_subagent", provider: "pi", event }),
        );
      }),
    );
    return groups.flat();
  }

  onToolStart(call: PiExtensionToolCall, provider = "pi"): AgentPermissionRequest | undefined {
    let request: AgentPermissionRequest | undefined;
    for (const { id, adapter } of this.sessions) {
      const candidate = this.safe(id, "onToolStart", () => adapter.onToolStart?.(call, provider));
      request ??= candidate;
    }
    return request;
  }

  onToolEnd(call: PiExtensionToolCall): void {
    for (const { id, adapter } of this.sessions) {
      this.safe(id, "onToolEnd", () => adapter.onToolEnd?.(call));
    }
  }

  mapDialog(dialog: PiExtensionDialog, provider: string): PiExtensionDialogMapping | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapping = this.safe(id, "mapDialog", () => adapter.mapDialog?.(dialog, provider));
      if (mapping) return mapping;
    }
    return undefined;
  }

  respondToPermission(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
  ): PiExtensionUiReply | undefined {
    for (const { id, adapter } of this.sessions) {
      const mapped = this.safe(id, "respondToPermission", () =>
        adapter.respondToPermission?.(request, response),
      );
      if (mapped) return mapped;
    }
    return undefined;
  }
}
