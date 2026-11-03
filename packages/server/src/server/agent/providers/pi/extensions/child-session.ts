import { open } from "node:fs/promises";
import { limitAgentTimelineItemContent } from "../../../agent-timeline-content.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import { PiHistoryMapper } from "../history-mapper.js";
import type { PiAgentMessage } from "../rpc-types.js";
import { extractTextFromToolResult, type PiToolResult } from "../tool-call-mapper.js";
import type { PiChildSessionFile } from "./contract.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 200;

type TimelineEvent = Extract<ProviderSubagentInputEvent, { type: "timeline" }>;
interface ChildEntry {
  id?: string;
  parentId?: string | null;
  message?: PiAgentMessage;
  timestamp?: string;
  type?: string;
  customType?: string;
  data?: { inheritedCount?: number };
}

export function outputFileFromToolResult(result: PiToolResult): string | undefined {
  return extractTextFromToolResult(result)?.match(/^Output file:\s*(\S+)$/m)?.[1];
}

/** Reads a finished child transcript once, up to `maxBytes`. */
export function mapPiChildSession(
  id: string,
  file: string,
  maxBytes = MAX_BYTES,
  branch?: PiChildSessionFile["branch"],
): Promise<ProviderSubagentInputEvent[]> {
  return new PiChildSessionFollower(id, file, maxBytes, branch).readNew();
}

/** Bounded JSONL follower. Manager branches select ancestry, other adapters remain append-only. */
export class PiChildSessionFollower {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private mapper = new PiHistoryMapper("pi");
  private readonly entries = new Map<string, ChildEntry>();
  private selected: string[] = [];
  private history: TimelineEvent[] = [];
  private warning?: string;
  private readonly maxBytes: number;
  private identity?: string;
  reset = false;

  constructor(
    private readonly id: string,
    readonly file: string,
    maxBytes = MAX_BYTES,
    private branch?: PiChildSessionFile["branch"],
  ) {
    this.maxBytes = Math.max(0, Math.min(maxBytes, MAX_BYTES));
  }

  setBranch(branch: PiChildSessionFile["branch"]): void {
    this.branch = branch;
  }

  snapshot(): ProviderSubagentInputEvent[] {
    return [...this.history];
  }

  private clear(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.entries.clear();
    this.selected = [];
    this.history = [];
    this.warning = undefined;
    this.mapper = new PiHistoryMapper("pi");
    this.reset = true;
  }

  private warn(message: string): TimelineEvent[] {
    if (this.warning) return [];
    this.warning = message;
    const event: TimelineEvent = {
      type: "timeline",
      id: this.id,
      item: { type: "notification", level: "warning", message },
    };
    this.history.push(event);
    return [event];
  }

  private async map(entry: ChildEntry): Promise<TimelineEvent[]> {
    if (!entry.message || typeof entry.message !== "object" || !("role" in entry.message))
      return [];
    const mapped = (await this.mapper.mapMessages([entry.message])).flatMap(
      (event): TimelineEvent[] =>
        event.type === "timeline"
          ? [
              {
                type: "timeline",
                id: this.id,
                item: limitAgentTimelineItemContent(event.item),
                ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
              },
            ]
          : [],
    );
    const room = Math.max(0, MAX_ITEMS - this.history.length);
    const kept = mapped.slice(0, room);
    this.history.push(...kept);
    return [
      ...kept,
      ...(mapped.length > room
        ? this.warn("Child transcript truncated at 200 timeline items.")
        : []),
    ];
  }

  private async ingest(data: Buffer): Promise<ProviderSubagentInputEvent[]> {
    const lastNewline = data.lastIndexOf(10);
    this.pending = data.subarray(lastNewline + 1);
    if (lastNewline < 0) return [];
    const events: ProviderSubagentInputEvent[] = [];
    for (const line of data.subarray(0, lastNewline).toString("utf8").split("\n")) {
      let entry: ChildEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      if (this.branch) {
        if (typeof entry.id === "string" && entry.type !== "session")
          this.entries.set(entry.id, entry);
      } else events.push(...(await this.map(entry)));
    }
    return events;
  }

  async readNew(): Promise<ProviderSubagentInputEvent[]> {
    this.reset = false;
    try {
      const handle = await open(this.file, "r");
      try {
        const stat = await handle.stat();
        const identity = `${stat.dev}:${stat.ino}`;
        if ((this.identity && this.identity !== identity) || stat.size < this.offset) this.clear();
        this.identity = identity;
        const size = Math.max(0, Math.min(stat.size, this.maxBytes) - this.offset);
        const events: ProviderSubagentInputEvent[] = [];
        if (size > 0) {
          const buffer = Buffer.alloc(size);
          const { bytesRead } = await handle.read(buffer, 0, size, this.offset);
          this.offset += bytesRead;
          const data = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
          events.push(...(await this.ingest(data)));
        }
        if (this.branch) events.push(...(await this.selectBranch()));
        if (stat.size > this.maxBytes) {
          const limit = this.maxBytes === MAX_BYTES ? "2 MiB" : `${this.maxBytes} bytes`;
          events.push(
            ...this.warn(`Child transcript truncated at ${limit}; later entries are not read.`),
          );
        }
        return events;
      } finally {
        await handle.close();
      }
    } catch {
      return this.branch
        ? this.warn("Child transcript unavailable; waiting for its session file.")
        : [];
    }
  }

  private async selectBranch(): Promise<ProviderSubagentInputEvent[]> {
    const chain: ChildEntry[] = [];
    const visited = new Set<string>();
    let leaf = this.branch!.leafId;
    while (leaf !== null) {
      // A checkpoint can precede the disk flush. Do not emit a partial or guessed branch.
      const entry = this.entries.get(leaf);
      if (!entry || visited.has(leaf)) return [];
      visited.add(leaf);
      chain.push(entry);
      leaf = entry.parentId ?? null;
    }
    chain.reverse();
    const ids = chain.map((entry) => entry.id!);
    if (!this.selected.every((id, index) => ids[index] === id)) {
      this.history = [];
      this.warning = undefined;
      this.mapper = new PiHistoryMapper("pi");
      this.selected = [];
      this.reset = true;
    }
    const ownership = chain.find(
      (entry) => entry.type === "custom" && entry.customType === "pi-subagent:thread:v1",
    );
    const inherited = ownership?.data?.inheritedCount;
    if (this.branch!.skipInherited && (!Number.isSafeInteger(inherited) || inherited! < 0)) {
      return this.warn(
        "Child transcript hidden: inherited-context boundary is unavailable (legacy session).",
      );
    }
    let skip = this.branch!.skipInherited ? inherited! : 0;
    const events: ProviderSubagentInputEvent[] = [];
    for (let index = 0; index < chain.length; index++) {
      const entry = chain[index]!;
      const isMessage = entry.type === "message" || entry.type === "custom_message";
      if (isMessage && skip > 0) {
        skip--;
        continue;
      }
      if (index >= this.selected.length) events.push(...(await this.map(entry)));
    }
    this.selected = ids;
    return events;
  }
}
