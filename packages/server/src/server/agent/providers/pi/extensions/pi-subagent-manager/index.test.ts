import { describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { mkdtemp, writeFile, appendFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiExtensionHost } from "../index.js";
import { PiChildSessionFollower } from "../child-session.js";
import { ProviderSubagentStore } from "../../../../provider-subagents/store.js";
import type { AgentStreamEvent } from "../../../../agent-sdk-types.js";
import { MANAGER_SNAPSHOT_MARKER, managerRuntimeBridge } from "./runtime-bridge.js";

const thread = (path = "/root/task", parent: string | null = "/root") => ({
  id: path,
  path,
  parent,
  state: "running",
  type: "coder",
  task: `Do ${path}`,
  status: "Working",
  createdAt: 1,
  updatedAt: 2,
});
const observation = (
  threads: (ReturnType<typeof thread> & {
    sessionFile?: string;
    sessionLeafId?: string | null;
  })[] = [thread()],
  revision = 1,
  generation = 1,
  rootSessionId = "session-a",
) =>
  `${MANAGER_SNAPSHOT_MARKER} ${JSON.stringify({ version: 1, rootSessionId, generation, revision, threads })}`;
const row = (id: string, parentId: string | null, text: string) =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n";
const ownership =
  JSON.stringify({
    type: "custom",
    customType: "pi-subagent:thread:v1",
    id: "o",
    parentId: null,
    data: { inheritedCount: 1 },
  }) + "\n";

function consume(store: ProviderSubagentStore, events: AgentStreamEvent[]) {
  for (const event of events) {
    if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
  }
}

describe("pi-subagent-manager observation v1", () => {
  test("runtime bridge discovers only the active session and unsubscribes on shutdown", () => {
    const bus = new EventEmitter();
    const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
    const notify = vi.fn();
    const ctx = { sessionManager: { getSessionId: () => "current" }, ui: { notify } };
    const pi = {
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        hooks.set(name, handler);
      },
      events: {
        on(name: string, handler: (data: unknown) => void) {
          bus.on(name, handler);
          return () => bus.off(name, handler);
        },
        emit: (name: string, data: unknown) => bus.emit(name, data),
      },
    };
    runInNewContext(managerRuntimeBridge, { pi });
    bus.on("pi-subagent-manager:observe:v1:request", () => {
      bus.emit("pi-subagent-manager:observe:v1:snapshot", {
        rootSessionId: "current",
        threads: [],
      });
    });
    hooks.get("session_start")!(undefined, ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain(MANAGER_SNAPSHOT_MARKER);
    bus.emit("pi-subagent-manager:observe:v1:snapshot", { rootSessionId: "old" });
    expect(notify).toHaveBeenCalledTimes(1);
    bus.emit("paseo:extensions:snapshot", ctx);
    expect(notify).toHaveBeenCalledTimes(2);
    hooks.get("session_shutdown")!(undefined, ctx);
    bus.emit("paseo:extensions:snapshot", ctx);
    bus.emit("pi-subagent-manager:observe:v1:snapshot", { rootSessionId: "current" });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test("replays an authentic offline SDK 1.0.2 nested-session capture through the existing store", async () => {
    const capture: {
      sdkVersion: string;
      observations: Array<{
        generation: number;
        revision: number;
        threads: Array<{ sessionFile: string }>;
      }>;
      transcripts: Array<{ file: string; jsonl: string }>;
    } = JSON.parse(await readFile(new URL("./fixtures/sdk-1.0.2.json", import.meta.url), "utf8"));
    expect(capture.sdkVersion).toBe("1.0.2");
    const dir = await mkdtemp(join(tmpdir(), "paseo-manager-capture-"));
    const store = new ProviderSubagentStore();
    const host = createPiExtensionHost();
    host.follow((event) => consume(store, [event]));
    try {
      for (const transcript of capture.transcripts)
        await writeFile(join(dir, transcript.file), transcript.jsonl);
      for (const snapshot of capture.observations) {
        for (const child of snapshot.threads) child.sessionFile = join(dir, child.sessionFile);
        const mapping = host.mapRuntimeNotification(
          `${MANAGER_SNAPSHOT_MARKER} ${JSON.stringify(snapshot)}`,
        )!;
        consume(store, mapping.events);
        await mapping.hydration;
      }
      const children = store.list("parent");
      expect(children).toHaveLength(2);
      const mainChild = children.find((child) => child.title === "/root/task")!;
      const nestedChild = children.find((child) => child.title === "/root/task/review")!;
      expect(nestedChild).toMatchObject({ parentSubagentId: mainChild.id, status: "completed" });
      const main = JSON.stringify(store.fetchTimeline("parent", mainChild.id));
      expect(main).toContain("Inspecting in a child.");
      expect(main).toContain("agent_spawn");
      expect(main).toContain("ANSWER /root/task");
      expect(main).not.toContain("INHERITED PARENT");
      const nested = JSON.stringify(store.fetchTimeline("parent", nestedChild.id));
      expect(nested).toContain("ANSWER /root/task/review");
      expect(nested).not.toContain("INHERITED PARENT");
      expect(nested).not.toContain("Inspecting in a child.");
      const before = store.fetchTimeline("parent", mainChild.id).rows;
      consume(store, await host.snapshot());
      expect(store.fetchTimeline("parent", mainChild.id).rows.map((entry) => entry.item)).toEqual(
        before.map((entry) => entry.item),
      );
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("completion drains a fresh read after an in-flight read captured the earlier tail", async () => {
    const host = createPiExtensionHost();
    const store = new ProviderSubagentStore();
    host.follow((event) => consume(store, [event]));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let id = "";
    const read = vi
      .spyOn(PiChildSessionFollower.prototype, "readNew")
      .mockImplementationOnce(async () => {
        await gate;
        return [];
      })
      .mockImplementationOnce(async () => [
        {
          type: "timeline",
          id,
          item: { type: "assistant_message", text: "FINAL ANSWER" },
        },
      ]);
    try {
      const child = { ...thread(), sessionFile: "waiting", sessionLeafId: "a" };
      const started = host.mapRuntimeNotification(observation([child]))!;
      consume(store, started.events);
      id = started.subagents![0]!.id;
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(1);
      const finished = host.mapRuntimeNotification(
        observation([{ ...child, state: "completed", sessionLeafId: "b" }], 2),
      )!;
      consume(store, finished.events);
      release();
      await Promise.all([started.hydration, finished.hydration]);
      expect(read).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(store.fetchTimeline("parent", id))).toContain("FINAL ANSWER");
    } finally {
      release();
      host.close();
      read.mockRestore();
    }
  });

  test("late child reads cannot resurrect reaped/switched-session rows or publish after close", async () => {
    const host = createPiExtensionHost();
    const store = new ProviderSubagentStore();
    host.follow((event) => consume(store, [event]));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi
      .spyOn(PiChildSessionFollower.prototype, "readNew")
      .mockImplementationOnce(async () => {
        await gate;
        return [
          { type: "timeline", id: "stale", item: { type: "assistant_message", text: "STALE" } },
        ];
      });
    try {
      const started = host.mapRuntimeNotification(
        observation([{ ...thread(), sessionFile: "waiting", sessionLeafId: "a" }]),
      )!;
      consume(store, started.events);
      await Promise.resolve();
      const removed = host.mapRuntimeNotification(observation([], 1, 2))!;
      consume(store, removed.events);
      host.close();
      release();
      await started.hydration;
      expect(store.list("parent")).toEqual([]);
      expect(await host.snapshot()).toEqual([]);
    } finally {
      release();
      host.close();
      read.mockRestore();
    }
  });
  test("discovers parallel/nested threads with actual metadata, lifecycle buckets and stable resume identity", () => {
    const host = createPiExtensionHost();
    const threads = [thread(), thread("/root/task/review", "/root/task"), thread("/fresh", null)];
    Object.assign(threads[0]!, { model: "test/actual", thinkingLevel: "high" });
    const first = host.mapRuntimeNotification(observation(threads))!;
    expect(first.subagents).toHaveLength(3);
    const parent = first.subagents[0]!;
    expect(parent).toMatchObject({
      type: "upsert",
      description: "Do /root/task",
      subtitle: "running · coder · test/actual · high · Working",
    });
    expect(first.subagents[1]).toMatchObject({ parentSubagentId: parent.id });
    expect(first.subagents[2]).toMatchObject({
      parentSubagentId: null,
      subtitle: "running · coder · Working",
    });
    for (const [index, state] of [
      "completed",
      "failed",
      "stopped",
      "paused",
      "running",
    ].entries()) {
      threads[0]!.state = state;
      const mapped = host.mapRuntimeNotification(observation(threads, index + 2))!.subagents![0]!;
      expect(mapped.id).toBe(parent.id);
      const expected = {
        completed: "completed",
        failed: "failed",
        stopped: "canceled",
        paused: "completed",
        running: "running",
      }[state];
      expect(mapped).toMatchObject({ status: expected });
      if (state === "paused")
        expect(mapped).toMatchObject({
          subtitle: expect.stringContaining("Paused · no final answer"),
        });
    }
  });

  test("ignores stale revisions/generations and removes reaped or switched-session children", () => {
    const host = createPiExtensionHost();
    const initial = host.mapRuntimeNotification(observation())!;
    const id = initial.subagents![0]!.id;
    expect(host.mapRuntimeNotification(observation([], 2))!.subagents).toEqual([
      { type: "remove", id },
    ]);
    expect(host.mapRuntimeNotification(observation([thread()], 1))!.subagents).toEqual([]);
    const next = host.mapRuntimeNotification(observation([thread()], 1, 2, "session-b"))!;
    expect(next.subagents![0]!.id).not.toBe(id);
    expect(host.mapRuntimeNotification(observation([thread()], 100, 1))!.subagents).toEqual([]);
    expect(
      host.mapRuntimeNotification(observation([thread()], 100, 2, "session-a"))!.subagents,
    ).toEqual([]);
    expect(host.mapRuntimeNotification(`${MANAGER_SNAPSHOT_MARKER} {`)).toMatchObject({
      subagents: [],
    });
    expect(
      host.mapRuntimeNotification(observation([thread("/root/task/review", "/missing")], 3, 3))!
        .subagents,
    ).toEqual([]);
    expect(host.mapRuntimeNotification("other")).toBeUndefined();
  });

  test("follows child-only branch history, partial rows, resumed writes and rewind without duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-manager-"));
    const file = join(dir, "child.jsonl");
    try {
      await writeFile(
        file,
        ownership + row("inherited", "o", "PARENT CONTEXT") + row("a", "inherited", "CHILD"),
      );
      const reader = new PiChildSessionFollower("child", file, undefined, {
        leafId: "a",
        skipInherited: true,
      });
      expect(JSON.stringify(await reader.readNew())).not.toContain("PARENT CONTEXT");
      expect(reader.snapshot()).toHaveLength(1);
      expect(await reader.readNew()).toEqual([]);
      const next = row("b", "a", "RESUMED");
      reader.setBranch({ leafId: "b", skipInherited: true });
      await appendFile(file, next.slice(0, -3));
      expect(await reader.readNew()).toEqual([]);
      await appendFile(file, next.slice(-3));
      expect(JSON.stringify(await reader.readNew())).toContain("RESUMED");
      expect(reader.reset).toBe(false);
      reader.setBranch({ leafId: "a", skipInherited: true });
      expect(JSON.stringify(await reader.readNew())).toContain("CHILD");
      expect(reader.reset).toBe(true);
      expect(JSON.stringify(reader.snapshot())).not.toContain("RESUMED");
      await appendFile(file, row("c", "a", "BRANCH"));
      reader.setBranch({ leafId: "c", skipInherited: true });
      expect(JSON.stringify(await reader.readNew())).toContain("BRANCH");
      expect(reader.snapshot()).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reconnect replay replaces child timelines, retains identity and follows post-completion resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-manager-host-"));
    const file = join(dir, "child.jsonl");
    const host = createPiExtensionHost();
    const store = new ProviderSubagentStore();
    host.follow((event) => consume(store, [event]));
    try {
      await writeFile(
        file,
        ownership + row("inherited", "o", "PARENT") + row("a", "inherited", "FIRST"),
      );
      const child = { ...thread(), sessionFile: file, sessionLeafId: "a" };
      const first = host.mapRuntimeNotification(observation([child]))!;
      consume(store, first.events);
      await first.hydration;
      const id = first.subagents![0]!.id;
      const fetch = () => store.fetchTimeline("parent", id).rows;
      expect(fetch()).toHaveLength(1);
      for (let count = 0; count < 2; count++) {
        consume(store, await host.snapshot());
        expect(fetch()).toHaveLength(1);
      }
      child.state = "completed";
      const done = host.mapRuntimeNotification(observation([child], 2))!;
      consume(store, done.events);
      await done.hydration;
      await appendFile(file, row("b", "a", "SECOND"));
      child.state = "running";
      child.sessionLeafId = "b";
      const resumed = host.mapRuntimeNotification(observation([child], 3))!;
      consume(store, resumed.events);
      await resumed.hydration;
      expect(fetch()).toHaveLength(2);
      expect(store.list("parent")).toHaveLength(1);
      child.sessionLeafId = "a";
      const rewound = host.mapRuntimeNotification(observation([child], 4))!;
      consume(store, rewound.events);
      await rewound.hydration;
      expect(fetch()).toHaveLength(1);
      const switched = host.mapRuntimeNotification(observation([], 1, 2, "new-session"))!;
      consume(store, switched.events);
      await switched.hydration;
      expect(store.list("parent")).toEqual([]);
      expect(await host.snapshot()).toEqual([]);
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ceilings and missing inherited boundaries are explicit, never presented as full history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-manager-limits-"));
    const file = join(dir, "child.jsonl");
    try {
      await writeFile(
        file,
        Array.from({ length: 205 }, (_, index) => row(String(index), null, String(index))).join(""),
      );
      const items = new PiChildSessionFollower("child", file);
      expect(JSON.stringify(await items.readNew())).toContain("truncated at 200");
      expect(items.snapshot()).toHaveLength(201);
      await appendFile(file, row("late", null, "late"));
      expect(await items.readNew()).toEqual([]);
      const legacy = new PiChildSessionFollower("child", file, undefined, {
        leafId: "1",
        skipInherited: true,
      });
      expect(JSON.stringify(await legacy.readNew())).toContain(
        "inherited-context boundary is unavailable",
      );
      const bytes = new PiChildSessionFollower("child", file, 5);
      expect(JSON.stringify(await bytes.readNew())).toContain("truncated at 5 bytes");
      await writeFile(file, row("replacement", null, "REPLACED"));
      expect(JSON.stringify(await items.readNew())).toContain("REPLACED");
      expect(items.reset).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
