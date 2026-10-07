import { relative } from "node:path";
import type {
  ProviderConnection,
  ProviderLaunch,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { PaseoToolCatalog, PaseoToolDefinition, PaseoToolResult } from "./tools/types.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentClient, AgentStreamEvent } from "./agent-sdk-types.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import { buildProviderRegistry } from "./provider-registry.js";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import { PluginAgentClientRegistry } from "./plugin-provider.js";
import {
  isStaleProviderSessionError,
  StaleProviderSessionError,
} from "./stale-provider-session-error.js";

const CAPABILITIES = [
  "prompt.message",
  "session.configure",
  "session.persistence",
  "session.subsession",
  "permission",
] as const;

interface ProviderHarnessOptions {
  capabilities?: ProviderConnection["capabilities"];
  completeTurn?: boolean;
  openChildren?: (rootSessionId: string, emit: (event: ProviderEvent) => void) => void;
  handleInput?: (input: ProviderInput, emit: (event: ProviderEvent) => void) => Promise<boolean>;
}

function createProviderHarness(options: ProviderHarnessOptions = {}) {
  let listener: ((event: ProviderEvent) => void) | null = null;
  let closeCount = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const inputs: ProviderInput[] = [];
  const emit = (event: ProviderEvent) => listener?.(event);
  const capabilities = options.capabilities ?? CAPABILITIES;

  const connection: ProviderConnection = {
    version: 1,
    capabilities,
    async send(input) {
      inputs.push(input);
      if (await options.handleInput?.(input, emit)) return;
      if (input.type === "catalog") {
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: {
            models: [{ id: "plugin-model", label: "Plugin model" }],
            modes: [{ id: "build", label: "Build" }],
            thinkingOptions: [{ id: "deep", label: "Deep" }],
            defaultModel: "plugin-model",
            defaultMode: "build",
            defaultThinkingOption: "deep",
          },
        });
        return;
      }
      if (input.type === "session.open") {
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities,
          restoration: "core",
          persistence: { version: 1, data: { token: "root" } },
          cwd: input.config.cwd,
        });
        emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            model: "plugin-model",
            mode: "build",
            models: [{ id: "plugin-model", label: "Plugin model" }],
            modes: [{ id: "build", label: "Build" }],
            thinkingOptions: [],
            settings: [
              {
                type: "select",
                id: "voice",
                label: "Voice",
                value: "direct",
                options: [{ label: "Direct", value: "direct" }],
              },
            ],
          },
        });
        emit({
          type: "session.opened",
          sessionId: "child-1",
          parentSessionId: input.sessionId,
          capabilities: [],
          restoration: "parent",
          title: "Plugin child",
          cwd: input.config.cwd,
        });
        emit({
          type: "timeline.item",
          sessionId: "child-1",
          item: { type: "assistant_message", id: "child-message", text: "Child result" },
        });
        emit({
          type: "session.turn",
          sessionId: "child-1",
          turnId: "child-turn",
          state: "completed",
        });
        emit({ type: "session.ready", sessionId: "child-1" });
        options.openChildren?.(input.sessionId, emit);
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        return;
      }
      if (input.type === "session.prompt") {
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "turn", turnId: "turn-1" },
        });
        emit({
          type: "session.turn",
          sessionId: input.sessionId,
          turnId: "turn-1",
          state: "started",
        });
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: { type: "assistant_message", id: "answer", text: "Hel" },
        });
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: { type: "assistant_message", id: "answer", text: "Hello" },
        });
        emit({
          type: "session.permission",
          sessionId: input.sessionId,
          request: { id: "permission-1", name: "write", kind: "tool" },
        });
        if (options.completeTurn !== false) {
          emit({
            type: "session.turn",
            sessionId: input.sessionId,
            turnId: "turn-1",
            state: "completed",
          });
        }
        return;
      }
      if (input.type === "session.permission") {
        emit({
          type: "session.permission_resolved",
          sessionId: input.sessionId,
          permissionId: input.permissionId,
        });
        return;
      }
      if (input.type === "session.configure") {
        emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            model: input.changes.model ?? "plugin-model",
            mode: "build",
            models: [{ id: "plugin-model", label: "Plugin model" }],
            modes: [{ id: "build", label: "Build" }],
            thinkingOptions: [],
            settings: [],
          },
        });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      if (input.type === "session.close") {
        emit({ type: "session.closed", sessionId: input.sessionId });
      }
      if ("requestId" in input) {
        emit({ type: "request.completed", requestId: input.requestId });
      }
    },
    onEvent(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    async close() {
      closeCount += 1;
      resolveClosed();
    },
  };

  const registration: ProviderRegistration = {
    id: "plugin-direct",
    label: "Plugin direct",
    async connect() {
      return connection;
    },
  };

  return {
    registration,
    emit,
    inputs,
    closeCount: () => closeCount,
    waitForClose: () => closed,
  };
}

function eventsOfType(events: AgentStreamEvent[], type: AgentStreamEvent["type"]) {
  return events.filter((event) => event.type === type);
}

function openNestedChildren(rootSessionId: string, emit: (event: ProviderEvent) => void) {
  for (const [sessionId, parentSessionId] of [
    ["a", rootSessionId],
    ["a.b", "a"],
    ["a.b.c", "a.b"],
    ["sibling", rootSessionId],
  ]) {
    emit({
      type: "session.opened",
      sessionId,
      parentSessionId,
      toolCallId: `${sessionId}-task`,
      capabilities: [],
      restoration: "parent",
      cwd: "/workspace",
    });
    emit({
      type: "timeline.item",
      sessionId,
      item: { type: "assistant_message", id: `${sessionId}-message`, text: sessionId },
    });
    emit({
      type: "session.turn",
      sessionId,
      turnId: `${sessionId}-turn`,
      state: "completed",
    });
  }
}

function expectNestedChildren(events: AgentStreamEvent[]) {
  for (const [id, parentSubagentId] of [
    ["a", null],
    ["a.b", "a"],
    ["a.b.c", "a.b"],
    ["sibling", null],
  ]) {
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "upsert",
          id,
          parentSubagentId,
          toolCallId: `${id}-task`,
          status: "running",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "timeline",
          id,
          item: expect.objectContaining({ text: id }),
        }),
      }),
    );
  }
}

describe("PluginAgentClientRegistry", () => {
  test.each([
    {
      label: "growing text",
      snapshots: [
        ["answer", "PASEO"],
        ["answer", "PASEO_JCODE"],
        ["answer", "PASEO_JCODE_RPC_OK"],
      ],
      fragments: ["PASEO", "_JCODE", "_RPC_OK"],
      finalText: "PASEO_JCODE_RPC_OK",
    },
    {
      label: "repeated fragments",
      snapshots: [
        ["answer", "a"],
        ["answer", "aa"],
      ],
      fragments: ["a", "a"],
      finalText: "aa",
    },
    {
      label: "full replacement",
      snapshots: [
        ["answer", "before"],
        ["answer", "after"],
        ["answer", "aftermath"],
      ],
      fragments: ["before", "after", "math"],
      finalText: "aftermath",
    },
    {
      label: "last assistant message",
      snapshots: [
        ["first", "working"],
        ["last", "final"],
        ["last", "final answer"],
      ],
      fragments: ["working", "final", " answer"],
      finalText: "final answer",
    },
  ])(
    "returns authoritative final text for $label while streaming deltas",
    async ({ snapshots, fragments, finalText }) => {
      const harness = createProviderHarness({
        async handleInput(input, emit) {
          if (input.type !== "session.prompt") return false;
          const turnId = input.prompt.clientMessageId;
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: turnId,
            result: { type: "turn", turnId },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
          await nextTurn();
          if (turnId === "answer-turn") {
            for (const [id, text] of snapshots) {
              emit({
                type: "timeline.item",
                sessionId: input.sessionId,
                item: { type: "assistant_message", id, text },
              });
              await nextTurn();
            }
          }
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
          return true;
        },
      });
      const registry = new PluginAgentClientRegistry(createTestLogger());
      registry.replace([harness.registration]);
      const client = registry.clients()[harness.registration.id]!;
      const session = await client.createSession({
        provider: harness.registration.id,
        cwd: "/workspace",
      });
      const result = await session.run("hello", { clientMessageId: "answer-turn" });
      expect(result.finalText).toBe(finalText);
      expect(result.timeline).toEqual(
        fragments.map((text) => expect.objectContaining({ type: "assistant_message", text })),
      );
      expect((await session.run("no response", { clientMessageId: "empty-turn" })).finalText).toBe(
        "",
      );
      await session.close();
      await registry.shutdown();
    },
  );
  test("negotiates native tools before manager launch and strips only internal MCP", async () => {
    const logger = createTestLogger();
    const harness = createProviderHarness({
      capabilities: [...CAPABILITIES, "tools.paseo.native", "tools.mcp"],
    });
    const registry = new PluginAgentClientRegistry(logger);
    registry.replace([
      {
        ...harness.registration,
        command: [process.execPath],
        status: async () => ({ available: true }),
      },
    ]);
    const catalog: PaseoToolCatalog = {
      tools: new Map(),
      getTool: () => undefined,
      executeTool: async () => ({ content: [] }),
    };
    const manager = new AgentManager({
      logger,
      clients: registry.clients(),
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      paseoToolCatalogFactory: () => catalog,
    });
    const external = { type: "http", url: "http://example.test/mcp" } as const;
    const agent = await manager.createAgent(
      { provider: harness.registration.id, cwd: "/workspace", mcpServers: { external } },
      undefined,
      { workspaceId: undefined },
    );
    expect(harness.inputs.find((input) => input.type === "session.open")).toMatchObject({
      config: { mcpServers: { external }, paseoTools: [] },
    });
    const open = harness.inputs.find((input) => input.type === "session.open");
    if (open?.type !== "session.open") throw new Error("Expected open input");
    expect(Object.keys(open.config.mcpServers)).toEqual(["external"]);
    await agent.session?.close();
    await registry.shutdown();
  });

  test("keeps native tool catalogs and call IDs isolated across sessions and reopen", async () => {
    const harness = createProviderHarness({
      capabilities: [...CAPABILITIES, "tools.paseo.native"],
    });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    for (const caller of ["first", "second"]) {
      const tool: PaseoToolDefinition = {
        name: caller,
        description: caller,
        handler: async () => ({ content: [{ type: "text", text: caller }] }),
      };
      const catalog: PaseoToolCatalog = {
        tools: new Map([[caller, tool]]),
        getTool: (name) => (name === caller ? tool : undefined),
        executeTool: async (_name, input, context) => tool.handler(input, context ?? {}),
      };
      const session = await client.createSession(
        { provider: harness.registration.id, cwd: "/workspace" },
        { paseoTools: catalog },
      );
      const open = harness.inputs.findLast((input) => input.type === "session.open");
      if (open?.type !== "session.open") throw new Error("Expected open input");
      harness.emit({
        type: "session.tool_call",
        sessionId: open.sessionId,
        callId: "same-id",
        name: caller,
        input: {},
      });
      harness.emit({
        type: "session.tool_call",
        sessionId: open.sessionId,
        callId: "foreign-tool",
        name: caller === "first" ? "second" : "first",
        input: {},
      });
      await nextTurn();
      expect(harness.inputs).toContainEqual({
        type: "session.tool_result",
        sessionId: open.sessionId,
        callId: "same-id",
        result: { content: [{ type: "text", text: caller }] },
      });
      expect(harness.inputs).toContainEqual(
        expect.objectContaining({
          sessionId: open.sessionId,
          callId: "foreign-tool",
          result: expect.objectContaining({ isError: true }),
        }),
      );
      const persistence = session.describePersistence();
      if (!persistence) throw new Error("Expected session persistence");
      await session.close();
      const reopened = await client.resumeSession(
        persistence,
        { cwd: "/workspace" },
        { paseoTools: catalog },
      );
      const resume = harness.inputs.findLast((input) => input.type === "session.open");
      if (resume?.type !== "session.open") throw new Error("Expected resume input");
      expect(resume.config.paseoTools).toEqual(open.config.paseoTools);
      await reopened.close();
    }
    await registry.shutdown();
  });
  test("preserves daemon catalog filtering and schema validation for native tools", async () => {
    const logger = createTestLogger();
    const harness = createProviderHarness({
      capabilities: [...CAPABILITIES, "tools.paseo.native"],
    });
    const registry = new PluginAgentClientRegistry(logger);
    registry.replace([harness.registration]);
    const snapshots = new ProviderSnapshotManager({ logger });
    const spoken: string[] = [];
    const catalog = createPaseoToolCatalog({
      logger,
      agentManager: new AgentManager({ logger, clients: {} }),
      agentStorage: new AgentStorage("/unused-native-tools-test", logger),
      providerSnapshotManager: snapshots,
      callerAgentId: "caller-one",
      enableVoiceTools: true,
      paseoToolPolicy: { disabledTools: ["create_agent"] },
      resolveSpeakHandler: () => async (input) => {
        spoken.push(input.text);
      },
    });
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession(
      { provider: harness.registration.id, cwd: "/workspace" },
      { paseoTools: catalog },
    );
    const open = harness.inputs.find((input) => input.type === "session.open");
    if (open?.type !== "session.open") throw new Error("Expected open input");
    expect(open.config.paseoTools?.map((tool) => tool.name)).toEqual([...catalog.tools.keys()]);
    expect(open.config.paseoTools?.map((tool) => tool.name)).not.toContain("create_agent");
    harness.emit({
      type: "session.tool_call",
      sessionId: open.sessionId,
      callId: "good",
      name: "speak",
      input: { text: " hello " },
    });
    harness.emit({
      type: "session.tool_call",
      sessionId: open.sessionId,
      callId: "invalid",
      name: "speak",
      input: { text: 3 },
    });
    harness.emit({
      type: "session.tool_call",
      sessionId: open.sessionId,
      callId: "disabled",
      name: "create_agent",
      input: {},
    });
    await nextTurn();
    expect(spoken).toEqual(["hello"]);
    expect(harness.inputs.filter((input) => input.type === "session.tool_result")).toEqual(
      expect.arrayContaining([
        {
          type: "session.tool_result",
          sessionId: open.sessionId,
          callId: "good",
          result: { content: [], structuredContent: { ok: true } },
        },
        expect.objectContaining({
          callId: "invalid",
          result: expect.objectContaining({ isError: true }),
        }),
        {
          type: "session.tool_result",
          sessionId: open.sessionId,
          callId: "disabled",
          result: {
            content: [{ type: "text", text: "Unknown Paseo tool: create_agent" }],
            isError: true,
          },
        },
      ]),
    );
    await session.close();
    await registry.shutdown();
    await snapshots.shutdown();
  });
  test.each([
    { capabilities: CAPABILITIES, native: false, mcp: true },
    { capabilities: [...CAPABILITIES, "tools.paseo.native"], native: true, mcp: false },
    { capabilities: [...CAPABILITIES, "tools.paseo.native", "tools.mcp"], native: true, mcp: true },
  ])(
    "negotiates tool transports without changing legacy providers: $capabilities",
    async ({ capabilities, native, mcp }) => {
      const harness = createProviderHarness({ capabilities });
      const registry = new PluginAgentClientRegistry(createTestLogger());
      registry.replace([harness.registration]);
      const client = registry.clients()[harness.registration.id]!;
      await client.isAvailable();
      expect(client.capabilities).toMatchObject({
        supportsNativePaseoTools: native,
        supportsMcpServers: mcp,
      });
      await registry.shutdown();
    },
  );

  test("registers only serializable session tools, validates calls and rejects unknown tools", async () => {
    const harness = createProviderHarness({
      capabilities: [...CAPABILITIES, "tools.paseo.native"],
    });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const seen: unknown[] = [];
    const schema = z.object({ message: z.string() });
    const tool: PaseoToolDefinition = {
      name: "echo",
      description: "Echo message",
      inputSchema: schema,
      async handler(input) {
        seen.push(input);
        return {
          content: [{ type: "text", text: "scoped" }],
          structuredContent: { caller: "one" },
        };
      },
    };
    const catalog: PaseoToolCatalog = {
      tools: new Map([[tool.name, tool]]),
      getTool: (name) => (name === tool.name ? tool : undefined),
      executeTool: async (_name, input, context) =>
        tool.handler(await schema.parseAsync(input), context ?? {}),
    };
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession(
      { provider: harness.registration.id, cwd: "/workspace" },
      { paseoTools: catalog },
    );
    const open = harness.inputs.find((input) => input.type === "session.open")!;
    expect(open.type).toBe("session.open");
    if (open.type !== "session.open") throw new Error("Expected open input");
    expect(JSON.parse(JSON.stringify(open.config.paseoTools))).toEqual([
      {
        name: "echo",
        description: "Echo message",
        inputSchema: expect.objectContaining({
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        }),
      },
    ]);
    expect(open.config.paseoTools?.[0]).not.toHaveProperty("handler");
    harness.emit({
      type: "session.tool_call",
      sessionId: open.sessionId,
      callId: "good",
      name: "echo",
      input: { message: "hello" },
    });
    harness.emit({
      type: "session.tool_call",
      sessionId: open.sessionId,
      callId: "invalid",
      name: "echo",
      input: { message: 4 },
    });
    harness.emit({
      type: "session.tool_call",
      sessionId: open.sessionId,
      callId: "unknown",
      name: "forbidden",
      input: {},
    });
    harness.emit({
      type: "session.tool_call",
      sessionId: "not-owned",
      callId: "foreign",
      name: "echo",
      input: { message: "bad" },
    });
    await nextTurn();
    expect(seen).toEqual([{ message: "hello" }]);
    harness.emit({
      type: "session.tool_call",
      sessionId: open.sessionId,
      callId: "good",
      name: "echo",
      input: { message: "replayed" },
    });
    await nextTurn();
    expect(seen).toEqual([{ message: "hello" }]);
    const results = harness.inputs.filter((input) => input.type === "session.tool_result");
    expect(results).toHaveLength(3);
    expect(results).toContainEqual({
      type: "session.tool_result",
      sessionId: open.sessionId,
      callId: "good",
      result: { content: [{ type: "text", text: "scoped" }], structuredContent: { caller: "one" } },
    });
    expect(results).toContainEqual({
      type: "session.tool_result",
      sessionId: open.sessionId,
      callId: "unknown",
      result: { content: [{ type: "text", text: "Unknown Paseo tool: forbidden" }], isError: true },
    });
    expect(results).toContainEqual(
      expect.objectContaining({
        callId: "invalid",
        result: {
          content: [{ type: "text", text: expect.stringContaining("expected string") }],
          isError: true,
        },
      }),
    );
    await session.close();
    await registry.shutdown();
  });

  test.each(["cancel", "interrupt", "close", "closed", "failure", "shutdown"] as const)(
    "aborts native tool calls on %s and suppresses late results",
    async (action) => {
      const harness = createProviderHarness({
        capabilities: [...CAPABILITIES, "tools.paseo.native"],
      });
      const registry = new PluginAgentClientRegistry(createTestLogger());
      registry.replace([harness.registration]);
      let signal: AbortSignal | undefined;
      let finish!: (result: PaseoToolResult) => void;
      const tool: PaseoToolDefinition = {
        name: "wait",
        description: "Wait",
        handler: async () => ({ content: [] }),
      };
      const catalog: PaseoToolCatalog = {
        tools: new Map([[tool.name, tool]]),
        getTool: (name) => (name === tool.name ? tool : undefined),
        executeTool: async (_name, _input, context) => {
          signal = context?.signal;
          return new Promise<PaseoToolResult>((resolve) => {
            finish = resolve;
          });
        },
      };
      const client = registry.clients()[harness.registration.id]!;
      const session = await client.createSession(
        { provider: harness.registration.id, cwd: "/workspace" },
        { paseoTools: catalog },
      );
      const open = harness.inputs.find((input) => input.type === "session.open");
      if (open?.type !== "session.open") throw new Error("Expected open input");
      const event = {
        type: "session.tool_call",
        sessionId: open.sessionId,
        callId: "pending",
        name: "wait",
        input: {},
      } as const;
      harness.emit(event);
      harness.emit(event);
      expect(signal?.aborted).toBe(false);
      if (action === "cancel")
        harness.emit({ type: "session.tool_cancel", sessionId: open.sessionId, callId: "pending" });
      if (action === "interrupt") await session.interrupt();
      if (action === "close") await session.close();
      if (action === "closed") harness.emit({ type: "session.closed", sessionId: open.sessionId });
      if (action === "failure")
        harness.emit({
          type: "session.runtime_failed",
          sessionId: open.sessionId,
          error: { message: "Gone" },
        });
      if (action === "shutdown") await registry.shutdown();
      expect(signal?.aborted).toBe(true);
      finish({ content: [{ type: "text", text: "late" }] });
      await nextTurn();
      expect(harness.inputs.filter((input) => input.type === "session.tool_result")).toEqual([]);
      await registry.shutdown();
    },
  );

  test("stores only agent options while the plugin receives merged defaults", async () => {
    const logger = createTestLogger();
    const harness = createProviderHarness();
    const plugins = new PluginAgentClientRegistry(logger);
    plugins.replace([harness.registration]);
    const registry = buildProviderRegistry(logger, {
      pluginProviders: plugins.definitions(),
      providerOverrides: {
        "plugin-direct": { options: { nested: { base: true, replace: "config" } } },
      },
    });
    const manager = new AgentManager({
      logger,
      clients: { "plugin-direct": registry["plugin-direct"].createClient(logger) },
      providerDefinitions: { "plugin-direct": registry["plugin-direct"] },
    });
    const own = { nested: { replace: "agent" } };
    const agent = await manager.createAgent(
      { provider: "plugin-direct", cwd: "/tmp", providerOptions: own },
      undefined,
      { workspaceId: undefined },
    );
    expect(toStoredAgentRecord(agent).config?.providerOptions).toEqual(own);
    expect(harness.inputs.find((input) => input.type === "session.open")).toMatchObject({
      config: { providerOptions: { nested: { base: true, replace: "agent" } } },
    });
    await agent.session?.close();
  });

  test.each([
    { options: { nested: { base: true, replace: "config" }, list: [1, 2], scalar: "config" } },
    { params: { nested: { base: true, replace: "config" }, list: [1, 2], scalar: "config" } },
    {
      params: { ignored: true },
      options: { nested: { base: true, replace: "config" }, list: [1, 2], scalar: "config" },
    },
  ])(
    "merges configured options into plugin session.open, preserving caller input: %j",
    async (override) => {
      const logger = createTestLogger();
      const harness = createProviderHarness();
      const plugins = new PluginAgentClientRegistry(logger);
      plugins.replace([harness.registration]);
      const registry = buildProviderRegistry(logger, {
        pluginProviders: plugins.definitions(),
        providerOverrides: { "plugin-direct": ProviderOverrideSchema.parse(override) },
      });
      const client = registry["plugin-direct"].createClient(logger);
      const defaultsSession = await client.createSession({
        provider: "plugin-direct",
        cwd: "/tmp",
      });
      const defaultsOpen = harness.inputs.findLast((input) => input.type === "session.open")!;
      expect(defaultsOpen.config.providerOptions).toEqual({
        nested: { base: true, replace: "config" },
        list: [1, 2],
        scalar: "config",
      });
      await defaultsSession.close();
      const config = {
        provider: "plugin-direct",
        cwd: "/tmp",
        providerOptions: { nested: { replace: "agent" }, list: [3], scalar: null },
      };
      const session = await client.createSession(config);
      const open = harness.inputs.findLast((input) => input.type === "session.open")!;
      expect(open.config.providerOptions).toEqual({
        nested: { base: true, replace: "agent" },
        list: [3],
        scalar: null,
      });
      expect(config.providerOptions).toEqual({
        nested: { replace: "agent" },
        list: [3],
        scalar: null,
      });
      const handle = session.describePersistence()!;
      await session.close();
      const updatedRegistry = buildProviderRegistry(logger, {
        pluginProviders: plugins.definitions(),
        providerOverrides: {
          "plugin-direct": {
            options: {
              nested: { base: false, replace: "new-config" },
              list: [4],
              scalar: "new-config",
            },
          },
        },
      });
      const resumed = await updatedRegistry["plugin-direct"]
        .createClient(logger)
        .resumeSession(handle, config);
      const resumedOpen = harness.inputs.findLast((input) => input.type === "session.open")!;
      expect(resumedOpen.config.providerOptions).toEqual({
        nested: { base: false, replace: "agent" },
        list: [3],
        scalar: null,
      });
      await resumed.close();
    },
  );

  test.each([false, true])(
    "contains a failed session open while send is pending: %s",
    async (pendingSend) => {
      let listener: ((event: ProviderEvent) => void) | undefined;
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => unhandled.push(reason);
      const registry = new PluginAgentClientRegistry(createTestLogger());
      registry.replace([
        {
          id: "failing-provider",
          label: "Failing provider",
          async connect() {
            return {
              version: 1,
              capabilities: ["session.persistence"],
              async send(input) {
                if (input.type !== "session.open") return;
                listener?.({
                  type: "request.failed",
                  requestId: input.requestId,
                  error: { message: "OMP persistent session registration is in progress" },
                });
                // Keep acceptance pending across a Node event-loop turn, as IPC can do.
                if (pendingSend) await nextTurn();
              },
              onEvent(nextListener) {
                listener = nextListener;
                return () => {
                  listener = undefined;
                };
              },
              async close() {},
            };
          },
        },
      ]);
      process.on("unhandledRejection", observeUnhandled);
      try {
        await expect(
          registry.clients()["failing-provider"]!.createSession({
            provider: "failing-provider",
            cwd: "/workspace",
          }),
        ).rejects.toThrow("OMP persistent session registration is in progress");
        await nextTurn();
        expect(unhandled).toEqual([]);
      } finally {
        await registry.shutdown();
        process.off("unhandledRejection", observeUnhandled);
      }
    },
  );

  test("preserves nested provider child ownership during opening", async () => {
    const harness = createProviderHarness({ openChildren: openNestedChildren });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const session = await registry.clients()[harness.registration.id]!.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    try {
      const events: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) events.push(event);
      expectNestedChildren(events);
    } finally {
      await session.close();
      registry.replace([]);
    }
  });

  test("preserves nested provider child ownership during live events", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const session = await registry.clients()[harness.registration.id]!.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    try {
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      const open = harness.inputs.find((input) => input.type === "session.open")!;
      openNestedChildren(open.sessionId, harness.emit);
      expectNestedChildren(events);
    } finally {
      await session.close();
      registry.replace([]);
    }
  });

  test("gates persistence operations on negotiated provider capabilities", async () => {
    const harness = createProviderHarness({ capabilities: ["session.persistence"] });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;

    await expect(client.isAvailable()).resolves.toBe(true);
    expect(client.capabilities).toMatchObject({
      supportsSessionPersistence: true,
      supportsSessionListing: false,
    });
    await expect(client.listImportableSessions?.()).resolves.toEqual([]);

    const persistence = {
      provider: harness.registration.id,
      sessionId: 'plugin:{"version":1,"data":{"token":"root"}}',
      metadata: { pluginProviderPersistence: { version: 1, data: { token: "root" } } },
    };
    await expect(client.archiveNativeSession?.(persistence)).resolves.toBeUndefined();
    await expect(client.unarchiveNativeSession?.(persistence)).resolves.toBeUndefined();
    expect(harness.inputs).toEqual([]);
    await registry.shutdown();
  });

  test("terminalizes an active turn exactly once when its plugin provider is removed", async () => {
    const harness = createProviderHarness({ completeTurn: false });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const run = session.run("hello", { clientMessageId: "active-message" });
    void run.catch(() => undefined);
    await expect.poll(() => eventsOfType(events, "turn_started")).toHaveLength(1);

    registry.replace([]);

    await expect
      .poll(() => eventsOfType(events, "turn_failed"))
      .toEqual([
        expect.objectContaining({
          type: "turn_failed",
          provider: harness.registration.id,
          turnId: "turn-1",
          error: "Provider connection closed",
        }),
      ]);
    await expect(run).rejects.toThrow("Provider connection closed");
    await expect.poll(harness.closeCount).toBe(1);

    registry.replace([]);
    expect(eventsOfType(events, "turn_failed")).toHaveLength(1);
  });

  test("leaves a completed session without a failure when its plugin provider is removed", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const session = await registry.clients()[harness.registration.id]!.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.run("hello", { clientMessageId: "completed-message" });
    expect(eventsOfType(events, "turn_completed")).toHaveLength(1);

    registry.replace([]);
    await harness.waitForClose();

    expect(eventsOfType(events, "turn_failed")).toEqual([]);
    await expect(
      session.startTurn("after reload", { clientMessageId: "after-reload" }),
    ).rejects.toBeInstanceOf(StaleProviderSessionError);
  });

  test("fails an accepted turn that has not started when its plugin provider is removed", async () => {
    const harness = createProviderHarness({
      handleInput: async (input, emit) => {
        if (input.type !== "session.prompt") return false;
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "turn", turnId: "accepted-turn" },
        });
        return true;
      },
    });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const session = await registry.clients()[harness.registration.id]!.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await expect(
      session.startTurn("hello", { clientMessageId: "accepted-message" }),
    ).resolves.toEqual({ turnId: "accepted-turn" });

    registry.replace([]);
    await harness.waitForClose();

    expect(eventsOfType(events, "turn_failed")).toEqual([
      expect.objectContaining({ error: "Provider connection closed" }),
    ]);
  });

  test("closes a stale session after its plugin provider is replaced", async () => {
    const old = createProviderHarness();
    const next = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());

    try {
      registry.replace([old.registration]);

      const stale = await registry.clients()[old.registration.id]!.createSession({
        provider: old.registration.id,
        cwd: "/workspace",
      });
      const persistence = stale.describePersistence();
      expect(persistence).not.toBeNull();

      registry.replace([next.registration]);
      await old.waitForClose();
      expect(old.closeCount()).toBe(1);

      await expect(stale.close()).resolves.toBeUndefined();

      const replacement = registry.clients()[next.registration.id];
      expect(replacement).toBeDefined();
      const resumed = await replacement!.resumeSession(persistence!, {
        cwd: "/workspace",
      });

      await expect(
        resumed.startTurn("after reload", { clientMessageId: "after-reload" }),
      ).resolves.toEqual({ turnId: "turn-1" });

      expect(next.inputs).toContainEqual(
        expect.objectContaining({
          type: "session.open",
          history: "replay",
          persistence: {
            version: 1,
            data: { token: "root" },
          },
        }),
      );

      await resumed.close();
    } finally {
      await registry.shutdown();
    }
  });

  test("prompting a stale session raises StaleProviderSessionError", async () => {
    const old = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());

    try {
      registry.replace([old.registration]);
      const stale = await registry.clients()[old.registration.id]!.createSession({
        provider: old.registration.id,
        cwd: "/workspace",
      });

      registry.replace([]);
      await old.waitForClose();
      expect(old.closeCount()).toBe(1);

      const failure = await stale
        .startTurn("after reload", { clientMessageId: "after-reload" })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(StaleProviderSessionError);
      expect(isStaleProviderSessionError(failure)).toBe(true);
      expect(isStaleProviderSessionError(new Error("Provider connection is closed"))).toBe(false);
      expect(isStaleProviderSessionError(new Error("boom"))).toBe(false);
    } finally {
      await registry.shutdown();
    }
  });

  test("adapts callback providers into the existing AgentClient and AgentSession path", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id];
    expect(client).toBeDefined();

    await expect(client!.fetchCatalog({ scope: "global", force: false })).resolves.toMatchObject({
      models: [
        {
          provider: "plugin-direct",
          id: "plugin-model",
          isDefault: true,
          thinkingOptions: [{ id: "deep", label: "Deep" }],
          defaultThinkingOptionId: "deep",
        },
      ],
      modes: [{ id: "build" }],
      defaultModeId: "build",
    });

    const session = await client!.createSession({ provider: "plugin-direct", cwd: "/workspace" });
    expect(session.features).toEqual([
      expect.objectContaining({
        type: "select",
        id: "voice",
        options: [{ id: "direct", label: "Direct", value: "direct" }],
      }),
    ]);
    expect(session.describePersistence()).toMatchObject({
      provider: "plugin-direct",
      metadata: { pluginProviderPersistence: { version: 1, data: { token: "root" } } },
    });

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) history.push(event);
    expect(history).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({ type: "timeline", id: "child-1" }),
      }),
    );
    expect(history).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({ type: "upsert", id: "child-1", status: "completed" }),
      }),
    );

    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    await expect(
      session.startTurn("hello", { clientMessageId: "client-message" }),
    ).resolves.toEqual({ turnId: "turn-1" });
    expect(
      events
        .filter((event) => event.type === "timeline")
        .map((event) => (event.type === "timeline" ? event.item : null)),
    ).toEqual([
      { type: "assistant_message", text: "Hel", messageId: "answer" },
      { type: "assistant_message", text: "lo", messageId: "answer" },
    ]);
    expect(session.getPendingPermissions()).toEqual([
      expect.objectContaining({ id: "permission-1", provider: "plugin-direct" }),
    ]);

    await session.respondToPermission("permission-1", { behavior: "allow" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "permission_resolved",
        requestId: "permission-1",
        resolution: { behavior: "allow" },
      }),
    );
    await session.setModel?.("plugin-model");
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "plugin-model",
      modeId: "build",
    });

    unsubscribe();
    await session.close();
    registry.replace([]);
    await expect.poll(harness.closeCount).toBe(1);
    expect(harness.inputs.map((input) => input.type)).toContain("session.close");
  });
});

type RequestKind = "session.open" | "catalog" | "session.configure" | "session.prompt";

async function requestFromClient(client: AgentClient, kind: RequestKind): Promise<unknown> {
  if (kind === "catalog") return client.fetchCatalog({ scope: "global" });
  const session = await client.createSession({ provider: client.provider, cwd: "/workspace" });
  if (kind === "session.open") return session;
  if (kind === "session.configure") return session.setMode("build");
  return session.startTurn("hello", { clientMessageId: "pending-message" });
}

async function withObservedProvider(
  options: ProviderHarnessOptions,
  run: (client: AgentClient, registry: PluginAgentClientRegistry) => Promise<void>,
): Promise<void> {
  const harness = createProviderHarness(options);
  const registry = new PluginAgentClientRegistry(createTestLogger());
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", observe);
  registry.replace([harness.registration]);
  try {
    await run(registry.clients()[harness.registration.id]!, registry);
    await registry.shutdown();
    await nextTurn();
    expect(unhandled).toEqual([]);
  } finally {
    await registry.shutdown();
    process.off("unhandledRejection", observe);
  }
}

test("commits notices emitted during session open as the initial timeline with stable history timestamps", async () => {
  await withObservedProvider(
    {
      openChildren(sessionId, emit) {
        emit({
          type: "session.notice",
          sessionId,
          notice: {
            id: "startup",
            severity: "warning",
            title: "Full access",
            description: "Tools run without asking.",
          },
        });
        emit({
          type: "session.notice",
          sessionId,
          notice: { id: "dismissed", severity: "info", title: "Hidden", dismissed: true },
        });
      },
    },
    async (client) => {
      const session = await client.createSession({ provider: client.provider, cwd: "/workspace" });
      try {
        expect(session.initialTimeline).toEqual([
          {
            timestamp: expect.any(String),
            item: {
              type: "notification",
              level: "warning",
              message: "Full access\nTools run without asking.",
            },
          },
        ]);
        const history: AgentStreamEvent[] = [];
        for await (const event of session.streamHistory()) history.push(event);
        expect(
          history.filter(
            (event) => event.type === "timeline" && event.item.type === "notification",
          ),
        ).toEqual([
          { type: "timeline", provider: client.provider, ...session.initialTimeline![0] },
        ]);
      } finally {
        await session.close();
      }
    },
  );
});

describe("pending provider responses", () => {
  test.each<RequestKind>(["session.open", "catalog", "session.configure", "session.prompt"])(
    "preserves the send error for %s",
    async (kind) => {
      const failure = new Error("Provider send failed");
      await withObservedProvider(
        {
          async handleInput(input) {
            if (input.type === kind) throw failure;
            return false;
          },
        },
        async (client) => {
          await expect(requestFromClient(client, kind)).rejects.toBe(failure);
        },
      );
    },
  );

  test.each([
    [
      "catalog",
      expect.objectContaining({
        models: [expect.objectContaining({ id: "plugin-model", isDefault: true })],
        defaultModeId: "build",
      }),
    ],
    ["session.configure", undefined],
  ] as const)(
    "contains an early request.failed for %s and permits a successful retry",
    async (kind, result) => {
      let failed = false;
      await withObservedProvider(
        {
          async handleInput(input, emit) {
            if (input.type !== kind || !("requestId" in input) || failed) return false;
            failed = true;
            emit({
              type: "request.failed",
              requestId: input.requestId,
              error: { message: "Provider request failed", code: "busy", diagnostic: "retry" },
            });
            await nextTurn();
            return true;
          },
        },
        async (client) => {
          await expect(requestFromClient(client, kind)).rejects.toMatchObject({
            message: "Provider request failed",
            code: "busy",
            diagnostic: "retry",
          });
          await expect(requestFromClient(client, kind)).resolves.toEqual(result);
        },
      );
    },
  );

  test.each([
    ["session.open", "Provider session closed"],
    ["session.configure", "Provider session closed"],
    ["session.prompt", StaleProviderSessionError],
  ] as const)("contains session closure while accepting %s", async (kind, error) => {
    await withObservedProvider(
      {
        async handleInput(input, emit) {
          if (input.type !== kind || !("sessionId" in input)) return false;
          emit({
            type: "session.closed",
            sessionId: input.sessionId,
            error: { message: "Provider session closed" },
          });
          await nextTurn();
          return true;
        },
      },
      async (client) => {
        await expect(requestFromClient(client, kind)).rejects.toThrow(error);
      },
    );
  });

  test.each([
    ["session.open", "Provider connection closed"],
    ["catalog", "Provider closed"],
    ["session.configure", "Provider closed"],
    ["session.prompt", StaleProviderSessionError],
  ] as const)("contains connection shutdown while accepting %s", async (kind, error) => {
    let disconnect!: () => Promise<void>;
    await withObservedProvider(
      {
        async handleInput(input) {
          if (input.type !== kind) return false;
          await disconnect();
          await nextTurn();
          return true;
        },
      },
      async (client, registry) => {
        disconnect = () => registry.shutdown();
        await expect(requestFromClient(client, kind)).rejects.toThrow(error);
      },
    );
  });

  test.each([true, false])(
    "preserves cancellation with acceptance pending: %s",
    async (pending) => {
      const controller = new AbortController();
      const reason = new Error("Catalog refresh cancelled");
      await withObservedProvider(
        {
          async handleInput(input) {
            if (input.type !== "catalog") return false;
            if (pending) {
              controller.abort(reason);
              await nextTurn();
            } else {
              setImmediate(() => controller.abort(reason));
            }
            return true;
          },
        },
        async (client) => {
          await expect(
            client.fetchCatalog({ scope: "global" }, { signal: controller.signal }),
          ).rejects.toBe(reason);
        },
      );
    },
  );
});

describe("plugin provider launch and status", () => {
  test("resolves the executable against the provider's PATH override", async () => {
    const harness = createProviderHarness();
    const registration: ProviderRegistration = { ...harness.registration, command: ["node"] };
    const logger = createTestLogger();
    const registry = new PluginAgentClientRegistry(logger);
    registry.replace([registration]);
    try {
      const definition = registry.definitions()[registration.id]!;
      const client = definition.createClient(logger, { env: { PATH: "/paseo-nonexistent-bin" } });
      expect(await client.isAvailable()).toBe(false);
      expect(await client.getDiagnostic!()).toEqual({ diagnostic: "node not found on PATH" });
    } finally {
      await registry.shutdown();
    }
  });

  test("strips parent-session and daemon-control variables from session env overlays", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    try {
      const client = registry.clients()[harness.registration.id]!;
      await client.createSession(
        { provider: harness.registration.id, cwd: "/workspace" },
        {
          env: {
            SESSION_TOKEN: "session",
            PASEO_AGENT_ID: "agent",
            CLAUDECODE: "parent",
            PASEO_NODE_ENV: "development",
          },
        },
      );
      const input = harness.inputs.find((value) => value.type === "session.open");
      expect(input).toMatchObject({
        config: { env: { SESSION_TOKEN: "session", PASEO_AGENT_ID: "agent" } },
      });
      if (input?.type !== "session.open") throw new Error("Expected session.open");
      expect(input.config.env).not.toHaveProperty("CLAUDECODE");
      expect(input.config.env).not.toHaveProperty("PASEO_NODE_ENV");
    } finally {
      await registry.shutdown();
    }
  });

  test("resolves relative executable paths before sending launch data", async () => {
    const harness = createProviderHarness();
    const launches: Array<ProviderLaunch | undefined> = [];
    const registration: ProviderRegistration = {
      ...harness.registration,
      command: [relative(process.cwd(), process.execPath)],
      async connect(request) {
        launches.push(request.launch);
        return harness.registration.connect(request);
      },
    };
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([registration]);
    try {
      await registry.clients()[registration.id]!.fetchCatalog({ scope: "global" });
      expect(launches).toMatchObject([{ command: process.execPath }]);
    } finally {
      await registry.shutdown();
    }
  });

  test("a missing executable is unavailable with a diagnostic without connecting", async () => {
    const harness = createProviderHarness();
    const registration: ProviderRegistration = {
      ...harness.registration,
      command: ["paseo-nonexistent-provider-executable"],
    };
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([registration]);
    try {
      const client = registry.clients()[registration.id]!;
      expect(await client.isAvailable()).toBe(false);
      expect(await client.getDiagnostic!()).toEqual({
        diagnostic: "paseo-nonexistent-provider-executable not found on PATH",
      });
      expect(harness.inputs).toEqual([]);
    } finally {
      await registry.shutdown();
    }
  });

  test.each([
    { mode: "default" as const },
    { mode: "append" as const, args: ["extra"] },
    { mode: "replace" as const, argv: [process.execPath, "replacement"] },
  ])(
    "resolves $mode launch and supplies identical data to status, catalogue identity, and connect",
    async (command) => {
      const harness = createProviderHarness();
      const launches: Array<ProviderLaunch | undefined> = [];
      const registration: ProviderRegistration = {
        ...harness.registration,
        command: [process.execPath, "default"],
        async status(request) {
          launches.push(request.launch);
          return { available: true };
        },
        async getCatalogCacheKey(options) {
          launches.push(options.launch);
          return "shared";
        },
        async connect(request) {
          launches.push(request.launch);
          return harness.registration.connect(request);
        },
      };
      const logger = createTestLogger();
      const registry = new PluginAgentClientRegistry(logger);
      registry.replace([registration]);
      try {
        const client = registry.definitions()[registration.id]!.createClient(logger, {
          command,
          env: { PLUGIN_SETTING: "custom", CLAUDECODE: "parent" },
        });
        expect(await client.isAvailable()).toBe(true);
        expect(await client.getCatalogCacheKey!({ scope: "global" })).toBe("shared");
        await client.fetchCatalog({ scope: "global" });
        let expectedArgs = ["default"];
        if (command.mode === "replace") expectedArgs = ["replacement"];
        if (command.mode === "append") expectedArgs = ["default", "extra"];
        expect(launches).toHaveLength(3);
        for (const launch of launches) {
          expect(launch).toMatchObject({
            command: process.execPath,
            args: expectedArgs,
            env: { PLUGIN_SETTING: "custom" },
          });
          expect(launch!.env).not.toHaveProperty("CLAUDECODE");
          expect(launch!.env).not.toHaveProperty("PASEO_NODE_ENV");
        }
        expect(launches[0]).toEqual(launches[1]);
        expect(launches[1]).toEqual(launches[2]);
      } finally {
        await registry.shutdown();
      }
    },
  );
});
