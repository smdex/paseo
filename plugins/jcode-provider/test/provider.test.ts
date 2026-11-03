import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { Connection } from "../server/connection.js";
import { attachedSchema, JcodeError, sessionsSchema } from "../server/wire.js";
import { readCatalog, routeModel, runtimeConfig, thinkingOptions } from "../server/catalog.js";
import { Session } from "../server/session.js";
import { createJcodeProvider } from "../server/provider.js";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderInput,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";

const connections: Connection[] = [];
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
test("native diagnostics survive provider JSON transport", () => {
  const diagnostic = new JcodeError("unsupported_env", "Configure the Jcode service environment");
  const event = JSON.parse(
    JSON.stringify({ type: "request.failed", requestId: "diagnostic-request", error: diagnostic }),
  );
  expect(ProviderEventSchema.parse(event)).toEqual({
    type: "request.failed",
    requestId: "diagnostic-request",
    error: { code: "unsupported_env", message: "Configure the Jcode service environment" },
  });
});
afterEach(async () => {
  await Promise.all(
    roots.map(async (root) => {
      await writeFile(join(root, "requests.ndjson.release-discovery"), "");
      await writeFile(join(root, "requests.ndjson.release-detach"), "");
    }),
  );
  await Promise.allSettled([
    ...cleanups.splice(0).map((cleanup) => cleanup()),
    ...connections.splice(0).map((connection) => connection.close()),
  ]);
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
async function launchHarness(scenario = "normal") {
  const root = await mkdtemp(join(tmpdir(), "jcode-provider-"));
  roots.push(root);
  const requests = join(root, "requests.ndjson");
  const launch = {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url))],
    env: { JCODE_TEST_SCENARIO: scenario, JCODE_TEST_REQUESTS: requests },
  };
  return { launch, requests };
}
async function harness(scenario = "normal") {
  const { launch, requests } = await launchHarness(scenario);
  const connection = new Connection(launch);
  connections.push(connection);
  await connection.initialize();
  return { connection, launch, requests };
}
test("correlates native replies, uncorrelated admission, and detaches only the owned bridge", async () => {
  const { connection, requests } = await harness();
  expect(await connection.request("list_sessions", {}, sessionsSchema)).toMatchObject({
    sessions: [{ session_id: "saved-root" }],
  });
  await connection.request("attach_session", { session_id: "saved-root" }, attachedSchema);
  await expect(
    connection.request(
      "send_message",
      { session_id: "saved-root", content: "hello" },
      z.object({ ev: z.literal("message_accepted") }),
    ),
  ).resolves.toEqual({ ev: "message_accepted" });
  await connection.close();
  const log = await readFile(requests, "utf8");
  expect(log).toContain('"req":"detach_session"');
  expect(log).not.toContain('"req":"cancel"');
  expect(log).not.toContain('"req":"reload"');
});
test("native rejection settles prompt admission instead of waiting forever", async () => {
  const { connection } = await harness("rejected");
  await connection.request("attach_session", { session_id: "saved-root" }, attachedSchema);
  await expect(
    connection.request(
      "send_message",
      { session_id: "saved-root", content: "hello" },
      z.object({ ev: z.literal("message_accepted") }),
    ),
  ).rejects.toMatchObject({ code: "invalid_request", message: "Already processing a message" });
});
test("catalog uses the read-only CLI and keeps OAuth and API-key model routes distinct", async () => {
  const { launch, requests } = await harness();
  const catalog = await readCatalog(launch);
  expect(catalog.models.map((model) => model.id)).toEqual([
    "openai-api:gpt-test",
    "openai-oauth:gpt-test",
    "gpt-test",
  ]);
  expect(catalog.thinkingOptions?.map((option) => option.id)).toContain("swarm-deep");
  const log = await readFile(requests, "utf8");
  expect(log).not.toContain('"req":"create_session"');
  expect(log).not.toContain('"req":"set_model"');
});

const config: ProviderSessionConfig = {
  cwd: "/workspace",
  env: {},
  mcpServers: {},
  settings: {},
  persist: true,
};
function openInput(
  overrides: Partial<ProviderSessionConfig> = {},
  resume = false,
): Extract<ProviderInput, { type: "session.open" }> {
  return {
    type: "session.open",
    requestId: "open-one",
    sessionId: "paseo-root",
    config: { ...config, ...overrides },
    history: resume ? "replay" : "skip",
    ...(resume ? { persistence: { version: 1, data: { sessionId: "saved-root" } } } : {}),
  };
}
const prompt = {
  clientMessageId: "message-one",
  delivery: "auto" as const,
  input: { type: "message" as const, content: [{ type: "text" as const, text: "hello" }] },
};
async function sessionHarness(scenario = "normal", input = openInput()) {
  const { launch, requests } = await launchHarness(scenario);
  const host = new Connection(launch);
  const events: ProviderEvent[] = [];
  const session = new Session(input.sessionId, host, (event) => events.push(event));
  cleanups.push(() => session.close());
  await session.open(input, PROVIDER_CAPABILITIES);
  return { session, host, requests, events };
}
async function rows(requests: string): Promise<Record<string, unknown>[]> {
  return (await readFile(requests, "utf8"))
    .trim()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}
async function requestNames(requests: string): Promise<unknown[]> {
  return (await rows(requests)).filter((row) => row.req !== undefined).map((row) => row.req);
}

test("native model, effort and rename controls accept Ok then refresh committed state", async () => {
  const { session, requests, events } = await sessionHarness(
    "normal",
    openInput({ title: "Fresh title", model: "openai-api:gpt-fresh", thinkingOption: "high" }),
  );
  expect(session.config).toMatchObject({ model: "openai-api:gpt-fresh", thinkingOption: "high" });
  await session.configure({ model: "openai-api:gpt-next", thinkingOption: "low" });
  expect(session.config).toMatchObject({ model: "openai-api:gpt-next", thinkingOption: "low" });
  await session.prompt({
    clientMessageId: "rename-one",
    delivery: "auto",
    input: { type: "command", name: "rename", arguments: "New title" },
  });
  expect(events).toContainEqual({
    type: "session.prompt_result",
    sessionId: "paseo-root",
    clientMessageId: "rename-one",
    result: { type: "completed" },
  });
  expect(
    (await rows(requests)).filter((row) => row.req === "rename_session").map((row) => row.title),
  ).toEqual(["Fresh title", "New title"]);
});

test("import preserves native model and effort and defers even an empty tool catalog until foreground", async () => {
  const { session, requests } = await sessionHarness(
    "normal",
    openInput({ model: "openai-api:stored-default", thinkingOption: "max", paseoTools: [] }, true),
  );
  expect(session.config).toMatchObject({ model: "openai-api:gpt-test", thinkingOption: "medium" });
  expect(await requestNames(requests)).not.toContain("configure_tools");
  await session.prompt(prompt);
  const names = await requestNames(requests);
  expect(names).not.toContain("set_model");
  expect(names).not.toContain("set_reasoning_effort");
  expect(names.indexOf("configure_tools")).toBeLessThan(names.indexOf("send_message"));
  expect((await rows(requests)).find((row) => row.req === "configure_tools")).toMatchObject({
    tools: { custom: [] },
  });
});

test("busy imported sessions allow steering but detach without canceling the external turn", async () => {
  const { session, requests, events } = await sessionHarness(
    "busy-import",
    openInput({ paseoTools: [] }, true),
  );
  await expect(session.prompt(prompt)).rejects.toMatchObject({ code: "busy" });
  await session.prompt({ ...prompt, delivery: "steer" });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "session.prompt_result",
      result: expect.objectContaining({ type: "steer" }),
    }),
  );
  await session.close();
  const names = await requestNames(requests);
  expect(names).toContain("soft_interrupt");
  expect(names).toContain("detach_session");
  expect(names).not.toContain("configure_tools");
  expect(names).not.toContain("cancel");
  expect(names).not.toContain("cancel_soft_interrupts");
});

test("close waits for pending admission and cancels its own turn before detaching", async () => {
  const { session, host, requests, events } = await sessionHarness("delayed-admission");
  const pending = new Promise<void>((resolve) =>
    host.onEvent((frame) => {
      if (frame.ev === "admission_pending") resolve();
    }),
  );
  const sending = session.prompt(prompt);
  await pending;
  const closing = session.close();
  await host.request("ping", { release_admission: true }, z.object({ ev: z.literal("pong") }));
  await sending;
  await closing;
  const names = await requestNames(requests);
  expect(names.indexOf("send_message")).toBeLessThan(names.indexOf("cancel"));
  expect(names.indexOf("cancel")).toBeLessThan(names.indexOf("detach_session"));
  expect(
    events.filter((event) => event.type === "session.turn").map((event) => event.state),
  ).toEqual(["started", "canceled"]);
});

test("uncertain admission timeout prevents later prompts from consuming a stale acknowledgement", async () => {
  const { connection, requests } = await harness("delayed-admission");
  await connection.request("attach_session", { session_id: "saved-root" }, attachedSchema);
  await expect(
    connection.request(
      "send_message",
      { session_id: "saved-root", content: "first" },
      z.object({ ev: z.literal("message_accepted") }),
      20,
    ),
  ).rejects.toMatchObject({ code: "timeout" });
  await expect(
    connection.request(
      "send_message",
      { session_id: "saved-root", content: "second" },
      z.object({ ev: z.literal("message_accepted") }),
    ),
  ).rejects.toMatchObject({ code: "timeout" });
  await connection.close();
  expect(
    (await rows(requests)).filter((row) => row.req === "send_message").map((row) => row.content),
  ).toEqual(["first"]);
});

test.each(["cancel-failure", "detach-failure"])(
  "%s still closes the owned bridge and local session",
  async (scenario) => {
    const { session, requests, events } = await sessionHarness(scenario);
    if (scenario === "cancel-failure") await session.prompt(prompt);
    await expect(session.close()).rejects.toMatchObject({
      message: scenario === "cancel-failure" ? "Cancel rejected" : "Detach rejected",
    });
    expect(await requestNames(requests)).toContain("detach_session");
    expect(await rows(requests)).toContainEqual({ bridge_closed: true, session_id: "new-root" });
    expect(events).toContainEqual({ type: "session.closed", sessionId: "paseo-root" });
  },
);

test("framed replacement, usage and native callbacks preserve one assistant row and scoped results", async () => {
  const { session, events, requests } = await sessionHarness(
    "native-tool",
    openInput({
      paseoTools: [
        { name: "create_agent", description: "Create", inputSchema: { type: "object" } },
      ],
    }),
  );
  await session.prompt(prompt);
  await expect.poll(() => events.some((event) => event.type === "session.tool_call")).toBe(true);
  const assistant = events.flatMap((event) =>
    event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item] : [],
  );
  expect(assistant.map((item) => item.text)).toEqual(["draft", "final"]);
  expect(new Set(assistant.map((item) => item.id)).size).toBe(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "session.usage",
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 5 },
    }),
  );
  expect(events).toContainEqual({
    type: "session.tool_call",
    sessionId: "paseo-root",
    callId: "host-1",
    name: "create_agent",
    input: { prompt: "hello" },
  });
  await session.toolResult({
    type: "session.tool_result",
    sessionId: "paseo-root",
    callId: "host-1",
    result: { content: [{ type: "text", text: "created" }], structuredContent: { id: "child" } },
  });
  await expect
    .poll(() =>
      events.some((event) => event.type === "session.turn" && event.state === "completed"),
    )
    .toBe(true);
  expect(
    events.filter((event) => event.type === "session.turn").map((event) => event.state),
  ).toEqual(["started", "completed"]);
  expect((await rows(requests)).find((row) => row.req === "tool_result")).toMatchObject({
    session_id: "new-root",
    call_id: "host-1",
    output: JSON.stringify({
      content: [{ type: "text", text: "created" }],
      structuredContent: { id: "child" },
    }),
  });
  await expect(
    session.toolResult({
      type: "session.tool_result",
      sessionId: "paseo-root",
      callId: "foreign",
      result: { content: [] },
    }),
  ).rejects.toMatchObject({ code: "unknown_tool_call" });
});

test("interrupt aborts native callback ownership and clears queued steering before terminal cancellation", async () => {
  const { session, events, requests } = await sessionHarness("native-tool");
  await session.prompt(prompt);
  await session.prompt({ ...prompt, clientMessageId: "steer-one", delivery: "steer" });
  await session.interrupt();
  expect(events).toContainEqual({
    type: "session.tool_cancel",
    sessionId: "paseo-root",
    callId: "host-1",
  });
  expect(
    events.filter((event) => event.type === "session.turn").map((event) => event.state),
  ).toEqual(["started", "canceled"]);
  const names = await requestNames(requests);
  expect(names.indexOf("soft_interrupt")).toBeLessThan(names.indexOf("cancel_soft_interrupts"));
  expect(names.indexOf("cancel_soft_interrupts")).toBeLessThan(names.indexOf("cancel"));
});

test("parent closure prevents in-flight discovery from attaching an orphan child", async () => {
  const { launch, requests } = await launchHarness("discovery-close");
  const provider = await createJcodeProvider().connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
    launch,
  });
  cleanups.push(() => provider.close());
  await provider.send(openInput({ cwd: dirname(requests) }, true));
  await expect
    .poll(async () => (await requestNames(requests)).includes("list_sessions"))
    .toBe(true);
  const closing = provider.send({
    type: "session.close",
    requestId: "close-root",
    sessionId: "paseo-root",
  });
  await expect
    .poll(async () => (await requestNames(requests)).includes("detach_session"))
    .toBe(true);
  await writeFile(`${requests}.release-discovery`, "");
  await expect
    .poll(async () => (await rows(requests)).some((row) => row.discovery_released === true))
    .toBe(true);
  await writeFile(`${requests}.release-detach`, "");
  await closing;
  await provider.close();
  expect(
    (await rows(requests))
      .filter((row) => row.req === "attach_session")
      .map((row) => row.session_id),
  ).toEqual(["saved-root"]);
});

test("reasoning inference follows provider precedence and native Claude capability ladders", () => {
  const openrouter = thinkingOptions("OpenRouter/Anthropic", "claude-opus-4-7").map(
    (option) => option.id,
  );
  expect(openrouter).toContain("minimal");
  expect(openrouter).not.toContain("max");
  expect(thinkingOptions("openai-compatible:private", "llama-3")).toEqual([]);
  expect(thinkingOptions("Anthropic", "claude-sonnet-4-5")).toEqual([]);
  const opus45 = thinkingOptions("Anthropic", "claude-opus-4-5").map((option) => option.id);
  expect(opus45).not.toContain("max");
  const opus46 = thinkingOptions("Anthropic", "claude-opus-4-6").map((option) => option.id);
  expect(opus46).toContain("max");
  expect(opus46).not.toContain("xhigh");
  expect(thinkingOptions("Anthropic", "claude-opus-4-7").map((option) => option.id)).toContain(
    "xhigh",
  );
});

test("native route identity pins billed credentials and preserves Grok Build routing", () => {
  expect(routeModel("grok-4.6", "Grok Build", "grok-build-acp")).toBe("grok-build:grok-4.6");
  expect(routeModel("grok-build:grok-4.6", "Grok Build", "grok-build-acp")).toBe(
    "grok-build:grok-4.6",
  );
  expect(
    runtimeConfig({
      ev: "runtime_info",
      session_id: "saved-root",
      provider: "OpenAI",
      model: "gpt-test",
      auth_method: "api_key",
      routes: [
        {
          model: "gpt-test",
          provider: "OpenAI",
          api_method: "openai-oauth",
          available: true,
          detail: "",
        },
        {
          model: "gpt-test",
          provider: "OpenAI",
          api_method: "openai-api-key",
          available: true,
          detail: "",
        },
      ],
    }).model,
  ).toBe("openai-api:gpt-test");
});

test("canonical runtime profile identity respects provider casing and preserves ambiguous routes", () => {
  const route = {
    model: "glm-5.3",
    provider: "Z.AI",
    api_method: "openai-compatible:zai",
    available: true,
    detail: "",
  };
  const runtime = {
    ev: "runtime_info" as const,
    session_id: "saved-root",
    provider: "z.ai",
    auth_method: "api_key",
    model: "glm-5.3",
    routes: [route],
  };
  expect(runtimeConfig(runtime).model).toBe("zai:glm-5.3");
  expect(
    runtimeConfig({
      ...runtime,
      routes: [route, { ...route, api_method: "openai-compatible:other-profile" }],
    }).model,
  ).toBe("glm-5.3");
});

test("opaque CLI profile routes stay distinct and disabled without inventing authentication defaults", async () => {
  const { launch } = await launchHarness("opaque-catalog");
  const catalog = await readCatalog(launch);
  expect(catalog.defaultModel).toBe("gpt-test");
  expect(
    catalog.models.map((model) => ({ id: model.id, isSelectable: model.isSelectable })),
  ).toEqual([
    { id: "unresolved:0:Z.AI:gpt-test", isSelectable: false },
    { id: "unresolved:1:Private Profile:gpt-test", isSelectable: false },
    { id: "gpt-test", isSelectable: undefined },
  ]);
});

test("opaque CLI metadata is enriched only by read-only attachment to an existing session", async () => {
  const { launch, requests } = await launchHarness("opaque-catalog-existing");
  const catalog = await readCatalog(launch);
  expect(catalog.models.find((model) => model.id === "my-profile:gpt-test")).toMatchObject({
    isSelectable: true,
  });
  expect(catalog.models.some((model) => model.id.startsWith("unresolved:"))).toBe(false);
  expect(await requestNames(requests)).toEqual([
    "hello",
    "list_sessions",
    "attach_session",
    "get_runtime_info",
    "detach_session",
  ]);
  expect((await rows(requests)).find((row) => row.req === "attach_session")).toMatchObject({
    session_id: "saved-root",
  });
});
