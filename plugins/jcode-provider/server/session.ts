import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderEvent,
  ProviderInput,
  ProviderPrompt,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { Connection } from "./connection.js";
import { runtimeConfig, selectedModel, thinkingOptions } from "./catalog.js";
import {
  attachedSchema,
  historySchema,
  JcodeError,
  persistenceSchema,
  runtimeSchema,
  streamSchema,
  type NativeFrame,
  type NativeSession,
  type NativeStream,
} from "./wire.js";

const okSchema = z.object({ ev: z.literal("ok") });
const acceptedSchema = z.object({ ev: z.literal("message_accepted") });
const commands = [
  {
    name: "model",
    description: "Set the native model or authentication route",
    argumentHint: "model",
  },
  {
    name: "effort",
    description: "Set reasoning effort or swarm orchestration",
    argumentHint: "none|minimal|low|medium|high|xhigh|max|swarm|swarm-deep",
  },
  { name: "compact", description: "Compact native conversation history" },
  { name: "rename", description: "Rename the native session", argumentHint: "title" },
  { name: "cancel-steers", description: "Discard queued native interleaves" },
  { name: "background", description: "Move the running native tool into the background" },
];
const streamKinds = new Set<string>(streamSchema.options.map((schema) => schema.shape.ev.value));
interface ActiveTurn {
  id: string;
  own: boolean;
  stopped?: { reason: string; message: string };
}
interface Tool {
  name: string;
  input: string;
  output: string;
  status: "running" | "completed" | "failed" | "canceled";
  error?: string;
}
interface PendingPrompt {
  prompt: ProviderPrompt;
  text: string;
}
interface TerminalWaiter {
  resolve(): void;
  reject(error: Error): void;
}

export class Session {
  native: NativeSession | null = null;
  config: ProviderConfigState = { models: [], modes: [], thinkingOptions: [], settings: [] };
  private readonly nonce = randomUUID();
  private readonly texts = new Map<string, string>();
  private readonly tools = new Map<string, Tool>();
  private readonly hostCalls = new Set<string>();
  private readonly waiters = new Set<TerminalWaiter>();
  private readonly buffered: NativeStream[] = [];
  private active: ActiveTurn | null = null;
  private pending: PendingPrompt | null = null;
  private opening = true;
  private closed = false;
  private closing = false;
  private admission: Promise<unknown> | null = null;
  private textSequence = 0;
  private textId = "";
  private reasoning = "";
  private reasoningSequence = 0;
  private failed = false;
  private systemPrompt: string | undefined;
  private pendingTools: Extract<ProviderInput, { type: "session.open" }>["config"]["paseoTools"];

  constructor(
    readonly id: string,
    readonly host: Connection,
    private readonly emit: (event: ProviderEvent) => void,
  ) {
    host.onEvent((frame) => this.receive(frame));
    host.onFailure((error) => this.runtimeFailed(error));
  }

  async open(
    input: Extract<ProviderInput, { type: "session.open" }>,
    capabilities: readonly string[],
  ): Promise<void> {
    validateSessionConfig(input.config);
    this.systemPrompt = input.config.systemPrompt;
    const persistence = input.persistence;
    if (persistence && persistence.version !== 1)
      throw new JcodeError("invalid_persistence", "Unknown Jcode persistence version");
    await this.host.initialize();
    let attached;
    if (persistence) {
      const saved = persistenceSchema.parse(persistence.data);
      attached = await this.host.request(
        "attach_session",
        { session_id: saved.sessionId },
        attachedSchema,
      );
    } else
      attached = await this.host.request(
        "create_session",
        { working_dir: input.config.cwd },
        attachedSchema,
      );
    this.native = attached.session;
    const nativeId = this.native.session_id;
    const paseoTools = input.config.paseoTools ?? [];
    if (input.config.paseoTools !== undefined) {
      if (!this.host.capabilities.includes("session_tools"))
        throw new JcodeError(
          "unsupported",
          "Update the Jcode daemon and API bridge: native Paseo tools require session_tools",
        );
      this.pendingTools = paseoTools;
      if (!persistence) await this.registerTools();
    }
    if (input.config.model && !persistence)
      await this.host.request(
        "set_model",
        { session_id: nativeId, model: input.config.model },
        okSchema,
      );
    if (input.config.thinkingOption && !persistence)
      await this.host.request(
        "set_reasoning_effort",
        { session_id: nativeId, effort: input.config.thinkingOption },
        okSchema,
      );
    if (input.config.title && !persistence)
      await this.host.request(
        "rename_session",
        { session_id: nativeId, title: input.config.title },
        okSchema,
      );
    this.emitOpened({ requestId: input.requestId, capabilities, restoration: "core" });
    if (input.history === "replay" && persistence) await this.replay();
    await this.refreshConfig();
    this.ready(input.requestId);
  }

  async openChild(
    native: NativeSession,
    parentSessionId: string,
    capabilities: readonly string[],
  ): Promise<void> {
    await this.host.initialize();
    const attached = await this.host.request(
      "attach_session",
      { session_id: native.session_id },
      attachedSchema,
    );
    this.native = { ...native, ...attached.session };
    this.emitOpened({ capabilities, parentSessionId, restoration: "parent" });
    await this.replay();
    await this.refreshConfig();
    this.ready();
  }

  private emitOpened(
    fields: Pick<
      Extract<ProviderEvent, { type: "session.opened" }>,
      "capabilities" | "restoration" | "requestId" | "parentSessionId"
    >,
  ): void {
    const native = this.requireNative();
    this.emit({
      type: "session.opened",
      sessionId: this.id,
      ...fields,
      cwd: native.working_dir ?? "",
      title: native.title,
      description: native.agent_label,
      persistence: { version: 1, data: { sessionId: native.session_id } },
    });
  }
  private ready(requestId?: string): void {
    this.emit({ type: "session.commands", sessionId: this.id, commands });
    this.emit({ type: "session.ready", sessionId: this.id, requestId });
    this.opening = false;
    const native = this.requireNative();
    if (native.status === "processing") this.ensureTurn();
    for (const event of this.buffered.splice(0))
      if (event.session_id === native.session_id) this.apply(event);
  }
  private async replay(): Promise<void> {
    const history = await this.host.request(
      "get_history",
      { session_id: this.requireNative().session_id },
      historySchema,
    );
    for (const [index, message] of history.messages.entries()) {
      const id = `jcode:${history.session_id}:history:${index}`;
      if (message.role === "user")
        this.item({ type: "user_message", id, messageId: id, text: message.content });
      else if (message.role === "assistant")
        this.item({ type: "assistant_message", id, messageId: id, text: message.content });
      else if (message.role === "tool")
        this.item({
          type: "tool_call",
          id,
          callId: id,
          name: "Jcode tool",
          status: "completed",
          error: null,
          detail: { type: "plain_text", text: message.content },
        });
    }
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (this.active)
      throw new JcodeError(
        "busy",
        "Change the Jcode model or effort after the current turn finishes",
      );
    if (changes.mode !== undefined || Object.keys(changes.settings ?? {}).length)
      throw new JcodeError(
        "unsupported",
        "Jcode exposes orchestration through the native effort selector, not modes or settings",
      );
    const session_id = this.requireNative().session_id;
    try {
      if (changes.model !== undefined) {
        if (!changes.model) throw new JcodeError("invalid_model", "Choose an explicit Jcode model");
        await this.host.request("set_model", { session_id, model: changes.model }, okSchema);
      }
      if (changes.thinkingOption !== undefined)
        if (changes.thinkingOption === null)
          throw new JcodeError(
            "unsupported",
            "Jcode's native harness cannot reset effort to a model default. Choose an explicit effort.",
          );
        else
          await this.host.request(
            "set_reasoning_effort",
            { session_id, effort: changes.thinkingOption },
            okSchema,
          );
    } finally {
      await this.refreshConfig();
    }
  }
  private async refreshConfig(): Promise<void> {
    const runtime = await this.host.request(
      "get_runtime_info",
      { session_id: this.requireNative().session_id },
      runtimeSchema,
    );
    this.config = runtimeConfig(runtime);
    this.emit({ type: "session.config", sessionId: this.id, config: this.config });
  }
  private async registerTools(): Promise<void> {
    if (this.pendingTools === undefined) return;
    await this.host.request(
      "configure_tools",
      {
        session_id: this.requireNative().session_id,
        tools: {
          custom: this.pendingTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        },
      },
      okSchema,
    );
    this.pendingTools = undefined;
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closing || this.closed || this.failed)
      throw new JcodeError("closed", "Jcode session is closing or failed");
    if (this.pending) throw new JcodeError("busy", "Jcode prompt admission is pending");
    if (prompt.input.type === "command") {
      await this.command(prompt);
      return;
    }
    const text: string[] = [];
    const images: Array<[string, string]> = [];
    for (const part of prompt.input.content) {
      if (part.type === "image") images.push([part.mimeType, part.data]);
      else if (part.type === "text") text.push(part.text);
      else if (part.type === "uploaded_file") text.push(`Attached file: ${part.path}`);
      else text.push(JSON.stringify(part));
    }
    const content = text.join("\n\n");
    const session_id = this.requireNative().session_id;
    if (prompt.delivery === "steer") {
      const turn = this.active;
      if (!turn) throw new JcodeError("unavailable", "Jcode has no active turn to steer");
      if (prompt.clearPendingPermissions)
        throw new JcodeError("unsupported", "Jcode's harness does not expose permission release");
      await this.host.request(
        "soft_interrupt",
        { session_id, content, images, urgent: false },
        okSchema,
      );
      this.item({
        type: "user_message",
        id: `jcode:user:${prompt.clientMessageId}`,
        messageId: prompt.clientMessageId,
        clientMessageId: prompt.clientMessageId,
        text: content,
      });
      this.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "steer", turnId: turn.id },
      });
      return;
    }
    if (this.active)
      throw new JcodeError("busy", "Jcode is busy. Use steering or Paseo's follow-up queue");
    this.pending = { prompt, text: content };
    try {
      // Paseo supplies appended instructions. Native create_session.system_prompt would replace
      // Jcode's entire assembled prompt, including project instructions and tool guidance.
      this.admission = (async () => {
        await this.registerTools();
        await this.host.request(
          "send_message",
          { session_id, content, images, system_reminder: this.systemPrompt },
          acceptedSchema,
        );
      })();
      await this.admission;
    } catch (error) {
      this.pending = null;
      throw error;
    } finally {
      this.admission = null;
    }
  }

  private async command(prompt: ProviderPrompt): Promise<void> {
    if (prompt.input.type !== "command") return;
    if (prompt.delivery === "steer")
      throw new JcodeError("unsupported", "Jcode control commands cannot steer a turn");
    const session_id = this.requireNative().session_id;
    const argument = prompt.input.arguments.trim();
    switch (prompt.input.name.replace(/^\//, "")) {
      case "model":
        if (!argument)
          throw new JcodeError("invalid_request", "Usage: /model <native model or route>");
        await this.configure({ model: argument });
        break;
      case "effort":
        if (!argument)
          throw new JcodeError("invalid_request", "Usage: /effort <effort, swarm, or swarm-deep>");
        await this.configure({ thinkingOption: argument });
        break;
      case "compact":
        await this.host.request("compact", { session_id }, streamSchema);
        break;
      case "rename":
        await this.host.request(
          "rename_session",
          { session_id, title: argument || undefined },
          okSchema,
        );
        break;
      case "cancel-steers":
        await this.host.request("cancel_soft_interrupts", { session_id }, okSchema);
        break;
      case "background":
        await this.host.request("background_tool", { session_id }, okSchema);
        break;
      default:
        throw new JcodeError(
          "unsupported_command",
          `Jcode command /${prompt.input.name} is not available through the native harness`,
        );
    }
    this.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "completed" },
    });
  }

  async interrupt(): Promise<void> {
    await this.admission;
    const session_id = this.requireNative().session_id;
    await this.host.request("cancel_soft_interrupts", { session_id }, okSchema);
    const turn = this.active;
    if (!turn) {
      await this.host.request("cancel", { session_id }, okSchema);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter: TerminalWaiter | undefined;
    const terminal = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
      this.waiters.add(waiter);
      timer = setTimeout(
        () =>
          reject(
            new JcodeError(
              "timeout",
              "Jcode cancellation was acknowledged but the turn has not stopped",
            ),
          ),
        30000,
      );
    });
    void terminal.catch(() => {});
    try {
      await this.host.request("cancel", { session_id }, okSchema);
      if (this.active?.id !== turn.id) waiter?.resolve();
      await terminal;
    } finally {
      clearTimeout(timer);
      if (waiter) this.waiters.delete(waiter);
    }
  }

  async toolResult(input: Extract<ProviderInput, { type: "session.tool_result" }>): Promise<void> {
    if (!this.hostCalls.delete(input.callId))
      throw new JcodeError(
        "unknown_tool_call",
        "Jcode tool result does not belong to a pending call",
      );
    const result = input.result;
    await this.host.request(
      "tool_result",
      {
        session_id: this.requireNative().session_id,
        call_id: input.callId,
        output: JSON.stringify({
          content: result.content,
          structuredContent: result.structuredContent,
        }),
        error: result.isError ? "Paseo tool execution failed" : undefined,
      },
      okSchema,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    try {
      try {
        await this.admission;
      } catch {
        /* Failed admission is already surfaced by prompt. */
      }
      if (this.active?.own) await this.interrupt();
    } finally {
      try {
        await this.host.close();
      } finally {
        this.closed = true;
        this.cancelHostCalls();
        if (this.active) this.finishTurn("canceled");
        this.emit({ type: "session.closed", sessionId: this.id });
      }
    }
  }
  private receive(frame: NativeFrame): void {
    if (this.closed || this.failed) return;
    if (!streamKinds.has(frame.ev)) return;
    let event: NativeStream;
    try {
      event = streamSchema.parse(frame);
    } catch (error) {
      this.runtimeFailed(new JcodeError("invalid_frame", String(error)));
      return;
    }
    if (this.opening) {
      this.buffered.push(event);
      return;
    }
    if (event.session_id !== this.requireNative().session_id) return;
    this.apply(event);
  }
  private apply(event: NativeStream): void {
    switch (event.ev) {
      case "message_accepted":
        this.accept();
        return;
      case "text_delta":
        this.ensureTurn();
        this.updateText(event, false);
        return;
      case "text_replace":
        this.updateText(event, true);
        return;
      case "text_done":
        this.textId = "";
        return;
      case "reasoning_delta":
        this.ensureTurn();
        this.reasoning += event.text;
        this.item({
          type: "reasoning",
          id: `${this.nonce}:reasoning:${this.reasoningSequence}`,
          text: this.reasoning,
        });
        return;
      case "reasoning_done":
        this.reasoning = "";
        this.reasoningSequence++;
        return;
      case "tool_start":
      case "tool_exec":
        this.ensureTurn();
        this.ensureTool(event.call_id, event.name);
        this.publishTool(event.call_id);
        return;
      case "tool_input_delta": {
        const tool = this.ensureTool(event.call_id, "Jcode tool");
        tool.input += event.delta;
        this.publishTool(event.call_id);
        return;
      }
      case "tool_done": {
        const tool = this.ensureTool(event.call_id, event.name);
        tool.output = event.output;
        tool.error = event.error;
        tool.status = event.error ? "failed" : "completed";
        this.publishTool(event.call_id);
        return;
      }
      case "tool_call":
        this.ensureTurn();
        this.hostCalls.add(event.call_id);
        this.emit({
          type: "session.tool_call",
          sessionId: this.id,
          callId: event.call_id,
          name: event.name,
          input: event.input,
        });
        return;
      case "token_usage":
        this.emit({
          type: "session.usage",
          sessionId: this.id,
          turnId: this.active?.id,
          usage: {
            inputTokens: event.input,
            outputTokens: event.output,
            cachedInputTokens: event.cache_read_input,
          },
        });
        return;
      case "turn_stopped":
        this.ensureTurn();
        this.active!.stopped = { reason: event.reason, message: event.message };
        return;
      case "turn_done":
        this.finishNativeTurn();
        return;
      default:
        this.applyMetadata(event);
    }
  }
  private applyMetadata(event: NativeStream): void {
    switch (event.ev) {
      case "session_status":
        if (["running", "generating", "tool_running"].includes(event.status)) this.ensureTurn();
        return;
      case "model_info":
        this.config = {
          ...this.config,
          model: selectedModel(event) ?? this.config.model,
          thinkingOption: event.reasoning_effort,
          thinkingOptions: thinkingOptions(event.provider, event.model),
        };
        this.emit({ type: "session.config", sessionId: this.id, config: this.config });
        return;
      case "compacted":
        this.item({
          type: "compaction",
          id: `${this.nonce}:compaction:${randomUUID()}`,
          status: "completed",
          trigger: "manual",
        });
        return;
      case "session_recovery":
        this.emit({
          type: "session.notice",
          sessionId: this.id,
          notice: {
            id: "jcode-recovery",
            severity: "warning",
            title: "Jcode session was interrupted",
            description:
              event.reconnect_notice ??
              "Review the transcript before continuing. Paseo does not automatically send Jcode's recovery prompt.",
          },
        });
        return;
      case "session_renamed":
        if (this.native) this.native.title = event.display_title;
        return;
    }
  }
  private accept(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    const started = !this.active;
    const turn = this.active ?? { id: randomUUID(), own: true };
    turn.own = true;
    this.active = turn;
    this.item({
      type: "user_message",
      id: `jcode:user:${pending.prompt.clientMessageId}`,
      messageId: pending.prompt.clientMessageId,
      clientMessageId: pending.prompt.clientMessageId,
      text: pending.text,
    });
    this.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId: pending.prompt.clientMessageId,
      result: { type: "turn", turnId: turn.id },
    });
    if (started)
      this.emit({ type: "session.turn", sessionId: this.id, turnId: turn.id, state: "started" });
  }
  private ensureTurn(own = false): ActiveTurn {
    if (!this.active) {
      this.active = { id: randomUUID(), own };
      this.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId: this.active.id,
        state: "started",
      });
    }
    return this.active;
  }
  private updateText(
    event: Extract<NativeStream, { ev: "text_delta" | "text_replace" }>,
    replace: boolean,
  ): void {
    const nativeId = event.message_id ?? this.textId;
    if (!nativeId) this.textId = `legacy:${++this.textSequence}`;
    const key = nativeId || this.textId;
    const previous = this.texts.get(key) ?? "";
    const text = replace ? event.text : previous + event.text;
    this.texts.set(key, text);
    this.item({
      type: "assistant_message",
      id: `${this.nonce}:text:${key}`,
      messageId: `${this.nonce}:text:${key}`,
      text,
    });
  }
  private ensureTool(callId: string, name: string): Tool {
    const existing = this.tools.get(callId);
    if (existing) {
      if (name !== "Jcode tool") existing.name = name;
      return existing;
    }
    const tool: Tool = { name, input: "", output: "", status: "running" };
    this.tools.set(callId, tool);
    return tool;
  }
  private publishTool(callId: string): void {
    const tool = this.tools.get(callId)!;
    const detail: ProviderToolCallDetail = {
      type: "plain_text",
      label: tool.name,
      text: [tool.input, tool.output].filter(Boolean).join("\n\n"),
    };
    const identity = {
      type: "tool_call" as const,
      id: `${this.nonce}:tool:${callId}`,
      callId,
      name: tool.name,
      detail,
    };
    if (tool.status === "failed")
      this.item({ ...identity, status: "failed", error: tool.error ?? "Jcode tool failed" });
    else this.item({ ...identity, status: tool.status, error: null });
  }
  private finishNativeTurn(): void {
    const stopped = this.active?.stopped;
    if (!stopped) this.finishTurn("completed");
    else if (stopped.reason === "interrupted") this.finishTurn("canceled");
    else this.finishTurn("failed", new JcodeError(stopped.reason, stopped.message));
  }
  private finishTurn(state: "completed" | "failed" | "canceled", error?: JcodeError): void {
    const turn = this.active;
    if (!turn) return;
    for (const [callId, tool] of this.tools) {
      if (tool.status !== "running") continue;
      tool.status = "canceled";
      this.publishTool(callId);
    }
    this.cancelHostCalls();
    this.active = null;
    this.emit({ type: "session.turn", sessionId: this.id, turnId: turn.id, state, error });
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }
  private cancelHostCalls(): void {
    for (const callId of this.hostCalls)
      this.emit({ type: "session.tool_cancel", sessionId: this.id, callId });
    this.hostCalls.clear();
  }
  private runtimeFailed(error: JcodeError): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    this.finishTurn("failed", error);
    this.cancelHostCalls();
    this.emit({ type: "session.runtime_failed", sessionId: this.id, error });
  }
  private requireNative(): NativeSession {
    if (!this.native) throw new JcodeError("unknown_session", "Jcode session has not opened");
    return this.native;
  }
  private item(item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: this.id, item });
  }
}

function validateSessionConfig(
  config: Extract<ProviderInput, { type: "session.open" }>["config"],
): void {
  const keys = Object.keys(config.env).filter(
    (key) => key !== "PASEO_AGENT_ID" && key !== "PASEO_AGENT_CWD",
  );
  if (keys.length)
    throw new JcodeError(
      "unsupported_env",
      `Jcode's shared daemon cannot apply per-session environment overrides: ${keys.join(", ")}. Configure the Jcode service environment instead.`,
    );
  if (Object.keys(config.mcpServers).length)
    throw new JcodeError(
      "unsupported_mcp",
      "Jcode's shared harness cannot register per-session MCP servers. Configure them in Jcode or use native Paseo tools.",
    );
  if (config.toolPolicy)
    throw new JcodeError(
      "unsupported_tool_policy",
      "Jcode cannot approve an exact MCP identity for unattended execution",
    );
  if (
    config.mode ||
    Object.keys(config.settings).length ||
    Object.keys(config.providerOptions ?? {}).length
  )
    throw new JcodeError(
      "unsupported_options",
      "Jcode supports native model and effort choices, not provider modes, settings, or opaque options",
    );
}
