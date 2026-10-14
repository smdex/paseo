import { validateWSOutboundMessage } from "./validation/ws-outbound.js";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  MutableDaemonConfigSchema,
  MutableDaemonConfigPatchSchema,
  UsageReportEntrySchema,
  AgentSnapshotPayloadSchema,
  AgentTimelineEntryPayloadSchema,
  AgentTimelineItemPayloadSchema,
  BranchSuggestionsResponseSchema,
  CheckoutStatusResponseSchema,
  CheckoutPrCreateRequestSchema,
  CheckoutPrMergeRequestSchema,
  CheckoutForgeSetAutoMergeRequestSchema,
  CheckoutEditChangeResponseSchema,
  CheckoutFetchRebaseResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionOutboundMessageSchema,
  SessionInboundMessageSchema,
  UsageReportEntrySchema,
  WSHelloMessageSchema,
  WorkspaceSetupProgressMessageSchema,
  WorkspaceSetupSnapshotSchema,
} from "./messages.js";

test("terminal listings accept older rows and retain new per-terminal directories", () => {
  const response = {
    type: "list_terminals_response",
    payload: {
      requestId: "terminal-list",
      cwd: "/workspace",
      terminals: [{ id: "terminal", name: "Shell", workspaceId: "workspace" }],
    },
  };
  expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  const withDirectory = {
    ...response,
    payload: {
      ...response.payload,
      terminals: [{ ...response.payload.terminals[0], cwd: "/workspace/subdirectory" }],
    },
  };
  expect(SessionOutboundMessageSchema.parse(withDirectory)).toEqual(withDirectory);
});

const LegacySubAgentToolCallSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  error: z.unknown().nullable(),
  detail: z.object({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    log: z.string(),
    // Copied from v0.1.65-beta.3: actions was required even though the UI ignored it.
    actions: z.array(
      z.object({
        index: z.number().int().positive(),
        toolName: z.string(),
        summary: z.string().optional(),
      }),
    ),
  }),
});

const LegacyAgentCapabilityFlagsSchema = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
});

const LegacyAgentSnapshotPayloadSchema = AgentSnapshotPayloadSchema.extend({
  capabilities: LegacyAgentCapabilityFlagsSchema,
});

describe("wire schema compatibility", () => {
  test("hello parses with and without the project update capability", () => {
    const legacy = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "legacy-client",
      clientType: "mobile",
      protocolVersion: 1,
    });
    const capable = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "capable-client",
      clientType: "mobile",
      protocolVersion: 1,
      capabilities: { project_updates: true },
    });

    expect([legacy, capable]).toEqual([
      {
        type: "hello",
        clientId: "legacy-client",
        clientType: "mobile",
        protocolVersion: 1,
      },
      {
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { project_updates: true },
      },
    ]);
  });

  test("timeline replacement invalidation is opt-in and carries no timeline rows", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { timeline_replacement_invalidation: true },
      }).capabilities,
    ).toEqual({ timeline_replacement_invalidation: true });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.timeline.replacement",
        payload: { agentId: "agent-1", epoch: "epoch-2" },
      }),
    ).toEqual({
      type: "agent.timeline.replacement",
      payload: { agentId: "agent-1", epoch: "epoch-2" },
    });
  });

  test("server info strips unknown legacy features while accepting former turn identity", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "legacy-server",
      features: {
        workspaceGithubClone: true,
        agentTurnIdentity: true,
      },
    });

    expect(parsed).toEqual({
      status: "server_info",
      serverId: "legacy-server",
      hostname: null,
      version: null,
      features: { agentTurnIdentity: true },
    });
  });

  test("native PR workspace capability is optional and old feature parsers ignore it", () => {
    const older = { status: "server_info", serverId: "host", features: { checkoutJj: true } };
    expect(
      ServerInfoStatusPayloadSchema.parse(older).features?.checkoutJjPrWorkspace,
    ).toBeUndefined();
    const current = { ...older, features: { ...older.features, checkoutJjPrWorkspace: true } };
    expect(ServerInfoStatusPayloadSchema.parse(current).features?.checkoutJjPrWorkspace).toBe(true);
    const previous = z.object({
      status: z.literal("server_info"),
      serverId: z.string(),
      features: z.object({ checkoutJj: z.boolean().optional() }).optional(),
    });
    expect(previous.parse(current).features).toEqual({ checkoutJj: true });
  });

  test("assistant timeline message ids are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "old daemon shape",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "old daemon shape",
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "new daemon shape",
        messageId: "msg-1",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "new daemon shape",
      messageId: "msg-1",
    });
  });

  test("task progress fields are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [{ text: "Legacy task", completed: false }],
      }),
    ).toEqual({ type: "todo", items: [{ text: "Legacy task", completed: false }] });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [
          {
            id: "task-1",
            text: "Current task",
            activeForm: "Working on current task",
            status: "in_progress",
            completed: false,
          },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        {
          id: "task-1",
          text: "Current task",
          activeForm: "Working on current task",
          status: "in_progress",
          completed: false,
        },
      ],
    });
  });

  test("a sub-agent launch marker still parses against the v0.1.65-beta.3 schema", () => {
    const card = {
      type: "tool_call",
      callId: "call-sub-agent-1",
      name: "Task",
      status: "completed",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        childSessionId: "child-session-1",
        log: "",
        actions: [],
      },
    } as const;

    const parsed = LegacySubAgentToolCallSchema.parse(JSON.parse(JSON.stringify(card)));
    expect(parsed.detail).toMatchObject({ log: "", actions: [] });
    const { log: _log, ...withoutLog } = card.detail;
    expect(LegacySubAgentToolCallSchema.safeParse({ ...card, detail: withoutLog }).success).toBe(
      false,
    );
    expect(AgentTimelineItemPayloadSchema.parse({ ...card, detail: withoutLog })).toMatchObject({
      detail: { type: "sub_agent", description: "Inspect repository structure" },
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        ...card,
        detail: { ...card.detail, log: "[Read] README.md" },
      }),
    ).toMatchObject({ detail: { log: "[Read] README.md" } });
  });

  test("old clients parse agent snapshots with rewind capabilities", () => {
    const parsed = LegacyAgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: true,
        supportsRewindFiles: true,
        supportsRewindBoth: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities).toEqual({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    });
  });

  test("new clients parse agent snapshots without rewind capabilities", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities.supportsRewindConversation).toBe(false);
    expect(parsed.capabilities.supportsRewindFiles).toBe(false);
    expect(parsed.capabilities.supportsRewindBoth).toBe(false);
  });

  test("notification timeline items parse their level and message", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "notification",
        level: "warning",
        message: "Command blocked by user",
      }),
    ).toEqual({
      type: "notification",
      level: "warning",
      message: "Command blocked by user",
    });
  });
});

test("0.8 timeline and setup capabilities remain optional in the hello", () => {
  const hello = { type: "hello", clientId: "compat", clientType: "mobile", protocolVersion: 1 };
  expect(WSHelloMessageSchema.safeParse(hello).success).toBe(true);
  expect(
    WSHelloMessageSchema.parse({
      ...hello,
      capabilities: { plugin_timeline_items: true, workspace_setup_blocked: true },
    }).capabilities,
  ).toEqual({ plugin_timeline_items: true, workspace_setup_blocked: true });
});

test("plugin rows and identity merges require a capable receiver", () => {
  const item = {
    type: "plugin",
    id: "task",
    pluginId: "tasks",
    kind: "tasks",
    version: 1,
    data: { text: "Working" },
  };
  expect(AgentTimelineItemPayloadSchema.parse(item)).toEqual(item);
  const legacyItems = z.object({
    type: z.enum([
      "user_message",
      "assistant_message",
      "reasoning",
      "tool_call",
      "todo",
      "error",
      "notification",
      "compaction",
    ]),
  });
  expect(legacyItems.safeParse(item).success).toBe(false);
  const entry = {
    provider: "codex",
    item,
    timestamp: "2026-09-07T00:00:00.000Z",
    seqStart: 1,
    seqEnd: 2,
    sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
    collapsed: ["identity"],
  };
  expect(AgentTimelineEntryPayloadSchema.parse(entry)).toEqual(entry);
  const legacyCollapsed = z.array(z.enum(["assistant_merge", "reasoning_merge", "tool_lifecycle"]));
  expect(legacyCollapsed.safeParse(entry.collapsed).success).toBe(false);
});

test("blocked setup preserves the legacy failed shape and optional provenance", () => {
  const snapshot = {
    status: "blocked",
    error: null,
    detail: {
      type: "worktree_setup",
      worktreePath: "/workspace",
      branchName: "fork",
      log: "",
      commands: [],
    },
    blockedSource: {
      kind: "change_request",
      forge: "github",
      number: 42,
      headRepository: "contributor/project",
    },
  };
  expect(WorkspaceSetupSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  const legacyStatus = z.enum(["running", "completed", "failed"]);
  const legacySnapshot = WorkspaceSetupSnapshotSchema.omit({ blockedSource: true }).extend({
    status: legacyStatus,
  });
  expect(legacySnapshot.safeParse(snapshot).success).toBe(false);
  const failed = { ...snapshot, status: "failed", error: "Update Paseo to review and run setup." };
  expect(legacySnapshot.safeParse(failed).success).toBe(true);
  const progress = {
    type: "workspace_setup_progress",
    payload: { ...failed, workspaceId: "workspace" },
  };
  expect(WorkspaceSetupProgressMessageSchema.parse(progress)).toEqual(progress);
  expect(WorkspaceSetupSnapshotSchema.parse(legacySnapshot.parse(failed))).toEqual(
    legacySnapshot.parse(failed),
  );
});

test("usage login errors are additive and older reports still parse", () => {
  const entry = {
    id: "codex:account",
    account: {},
    fetchedAt: "2026-10-05T00:00:00.000Z",
    sourceId: "codex",
    sourceLabel: "Codex",
    report: { status: "error", error: "Usage API returned 500" },
  };
  const legacy = z.object({
    type: z.literal("usage.list_reports.update"),
    payload: z.object({
      requestId: z.string(),
      report: z.object({
        id: z.string(),
        account: z.object({ label: z.string().optional() }),
        fetchedAt: z.string(),
        sourceId: z.string(),
        sourceLabel: z.string(),
        icon: z.string().optional(),
        report: z.discriminatedUnion("status", [
          z.object({ status: z.literal("available"), windows: z.array(z.unknown()) }),
          z.object({ status: z.literal("unavailable"), problem: z.unknown() }),
          z.object({ status: z.literal("error"), error: z.string() }),
        ]),
      }),
    }),
  });
  const oldMessage = {
    type: "usage.list_reports.update",
    payload: { requestId: "usage", report: entry },
  };
  const newMessage = {
    ...oldMessage,
    payload: {
      ...oldMessage.payload,
      report: {
        ...entry,
        loginErrors: [{ harness: "Codex", report: entry.report }],
      },
    },
  };
  expect(SessionOutboundMessageSchema.parse(oldMessage)).toEqual(oldMessage);
  expect(SessionOutboundMessageSchema.parse(newMessage)).toEqual(newMessage);
  expect(legacy.parse(newMessage)).toEqual(oldMessage);
});

test("usage entries accept older failures and additive successful snapshots", () => {
  const oldEntry = {
    id: "source:account",
    sourceId: "source",
    sourceLabel: "Source",
    account: {},
    fetchedAt: "2026-10-17T10:06:00Z",
    report: { status: "error", error: "Rate limited" },
  };
  expect(UsageReportEntrySchema.parse(oldEntry)).toEqual(oldEntry);
  const retained = {
    ...oldEntry,
    lastSuccessful: {
      fetchedAt: "2026-10-17T10:00:00Z",
      report: { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct: 42 }] },
    },
  };
  expect(UsageReportEntrySchema.parse(retained)).toEqual(retained);
  const available = {
    ...oldEntry,
    report: retained.lastSuccessful.report,
    successfulAt: "2026-10-17T10:00:15Z",
  };
  expect(UsageReportEntrySchema.parse(available)).toEqual(available);
  expect(
    UsageReportEntrySchema.omit({ lastSuccessful: true, successfulAt: true }).parse(available),
  ).toEqual({ ...oldEntry, report: available.report });
  // An older client's entry shape strips the additive snapshot and still sees the failure.
  expect(UsageReportEntrySchema.omit({ lastSuccessful: true }).parse(retained)).toEqual(oldEntry);
  expect(
    UsageReportEntrySchema.safeParse({
      ...oldEntry,
      lastSuccessful: { fetchedAt: oldEntry.fetchedAt, report: oldEntry.report },
    }).success,
  ).toBe(false);
});

// Frozen setup detail shape from v0.8.0: log is required, command output is optional.
const ReleasedSetupDetailSchema = z.object({
  type: z.literal("worktree_setup"),
  worktreePath: z.string(),
  branchName: z.string(),
  log: z.string(),
  commands: z.array(
    z.object({
      index: z.number().int().positive(),
      command: z.string(),
      cwd: z.string(),
      log: z.string().optional().default(""),
      status: z.enum(["running", "completed", "failed"]),
      exitCode: z.number().nullable(),
      durationMs: z.number().nonnegative().optional(),
    }),
  ),
  truncated: z.boolean().optional(),
});

test("released setup clients parse empty combined logs and retain command output", () => {
  const detail = {
    type: "worktree_setup",
    worktreePath: "/workspace",
    branchName: "feature",
    log: "",
    commands: [
      {
        index: 1,
        command: "echo ready",
        cwd: "/workspace",
        log: "ready\n",
        status: "completed",
        exitCode: 0,
      },
    ],
  };
  const parsed = ReleasedSetupDetailSchema.parse(JSON.parse(JSON.stringify(detail)));
  expect(parsed).toEqual(detail);
  expect(parsed.commands[0]?.log).toBe("ready\n");
  const { log: _log, ...withoutLegacyField } = detail;
  expect(ReleasedSetupDetailSchema.safeParse(withoutLegacyField).success).toBe(false);
  expect(
    WorkspaceSetupSnapshotSchema.parse({
      status: "completed",
      detail: { ...detail, log: "old daemon combined output" },
      error: null,
    }).detail.log,
  ).toBe("old daemon combined output");
});

test("local STT language survives wire reads and patches", () => {
  const patch = {
    features: {
      dictation: { stt: { provider: "local", language: "fr" } },
      voiceMode: { stt: { provider: "local", language: null } },
    },
  };
  expect(MutableDaemonConfigPatchSchema.parse(patch)).toEqual(patch);
});

test("speech config reads remain compatible with clients before features and future providers", () => {
  const oldSchema = MutableDaemonConfigSchema.omit({ features: true, envOverrides: true });
  const oldRead = oldSchema.parse({
    providers: {},
    relay: { enabled: false },
    mcp: { enabled: true, injectIntoAgents: true },
  });
  const read = {
    ...oldRead,
    features: {
      dictation: { enabled: true, stt: { provider: "local", language: "fr" } },
      voiceMode: {
        enabled: false,
        stt: { provider: "future", model: "future-model", region: "eu" },
        tts: { provider: "openai", hasApiKey: false },
      },
    },
    envOverrides: { "features.voiceMode.stt.provider": "PASEO_VOICE_STT_PROVIDER" },
  };
  expect(oldSchema.parse(read)).toEqual(read);
  expect(MutableDaemonConfigSchema.parse(oldRead)).toEqual(oldRead);
  expect(MutableDaemonConfigSchema.parse(read).features?.dictation.stt).toEqual(
    read.features.dictation.stt,
  );
  expect(MutableDaemonConfigSchema.parse(read).features?.voiceMode.stt).toEqual(
    read.features.voiceMode.stt,
  );
  const oldPatchSchema = MutableDaemonConfigPatchSchema.omit({ features: true });
  const oldPatch = oldPatchSchema.parse({ relay: { enabled: true } });
  expect(MutableDaemonConfigPatchSchema.parse(oldPatch)).toEqual(oldPatch);
  expect(
    MutableDaemonConfigPatchSchema.parse({
      features: { voiceMode: { stt: { provider: "future", region: "eu" } } },
    }).features?.voiceMode?.stt,
  ).toEqual({ provider: "future", region: "eu" });
test("exact workspace refs and default bases remain optional across checkout wire versions", () => {
  const oldStatus = {
    type: "checkout_status_response",
    payload: {
      cwd: "/repo",
      isGit: true,
      isPaseoOwnedWorktree: false,
      repoRoot: "/repo",
      mainRepoRoot: null,
      currentBranch: null,
      isDirty: false,
      baseRef: null,
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      remoteUrl: null,
      error: null,
      requestId: "status",
    },
  };
  const newStatus = {
    ...oldStatus,
    payload: {
      ...oldStatus.payload,
      defaultWorkspaceBase: { refName: "@", displayName: "Current change" },
    },
  };
  const [notGit, local, managed] = CheckoutStatusResponseSchema.shape.payload.options;
  const legacyStatus = CheckoutStatusResponseSchema.extend({
    payload: z.union([
      notGit.omit({ defaultWorkspaceBase: true }),
      local.omit({ defaultWorkspaceBase: true }),
      managed.omit({ defaultWorkspaceBase: true }),
    ]),
  });
  expect(CheckoutStatusResponseSchema.parse(oldStatus)).toEqual(oldStatus);
  expect(CheckoutStatusResponseSchema.parse(newStatus)).toEqual(newStatus);
  expect(legacyStatus.parse(newStatus)).toEqual(oldStatus);
  const oldBranches = {
    type: "branch_suggestions_response",
    payload: {
      branches: ["main"],
      branchDetails: [{ name: "main", committerDate: 1, hasLocal: true, hasRemote: true }],
      error: null,
      requestId: "branches",
    },
  };
  const newBranches = {
    ...oldBranches,
    payload: {
      ...oldBranches.payload,
      branchDetails: [
        {
          ...oldBranches.payload.branchDetails[0],
          localRef: "a".repeat(40),
          remoteRef: "b".repeat(40),
          remoteName: "upstream",
          resumeLookupError: "Saved jj Resume lookup failed.",
        },
      ],
    },
  };
  const legacyDetail = BranchSuggestionsResponseSchema.shape.payload.shape.branchDetails
    .unwrap()
    .element.omit({ localRef: true, remoteRef: true, remoteName: true, resumeLookupError: true });
  const legacyBranches = BranchSuggestionsResponseSchema.extend({
    payload: BranchSuggestionsResponseSchema.shape.payload.extend({
      branchDetails: z.array(legacyDetail).optional(),
    }),
  });
  expect(BranchSuggestionsResponseSchema.parse(oldBranches)).toEqual(oldBranches);
  expect(BranchSuggestionsResponseSchema.parse(newBranches)).toEqual(newBranches);
  expect(legacyBranches.parse(newBranches)).toEqual(oldBranches);
  for (const message of [oldStatus, newStatus, oldBranches, newBranches]) {
    const envelope = { type: "session", message };
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  }
});

test("structured jj rewrite refusals remain compatible with legacy checkout errors", () => {
  const oldMessage = {
    type: "checkout.edit_change.response",
    payload: {
      requestId: "edit",
      cwd: "/native",
      success: false,
      changeId: null,
      commitId: null,
      bookmark: null,
      error: { code: "NOT_ALLOWED", message: "Review the affected native descendants." },
    },
  };
  const newMessage = {
    ...oldMessage,
    payload: {
      ...oldMessage.payload,
      error: { ...oldMessage.payload.error, reason: "rewrite_approval_required" },
    },
  };
  const legacyError = z.object({
    code: z.enum(["NOT_GIT_REPO", "NOT_ALLOWED", "MERGE_CONFLICT", "UNKNOWN"]),
    message: z.string(),
  });
  const legacyResponse = CheckoutEditChangeResponseSchema.extend({
    payload: CheckoutEditChangeResponseSchema.shape.payload.extend({
      error: legacyError.nullable(),
    }),
  });
  expect(legacyResponse.parse(newMessage)).toEqual(oldMessage);
  expect(SessionOutboundMessageSchema.parse(oldMessage)).toEqual(oldMessage);
  expect(SessionOutboundMessageSchema.parse(newMessage)).toEqual(newMessage);
  for (const message of [oldMessage, newMessage]) {
    const envelope = { type: "session", message };
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  }
});

test("native PR capture is optional across request wire versions", () => {
  const oldRequest = {
    type: "checkout_pr_create_request",
    cwd: "/workspace",
    title: "Kept title",
    requestId: "create",
  };
  const newRequest = { ...oldRequest, expectedChangeId: "captured" };
  const legacy = CheckoutPrCreateRequestSchema.omit({ expectedChangeId: true });
  expect(CheckoutPrCreateRequestSchema.parse(oldRequest)).toEqual(oldRequest);
  expect(CheckoutPrCreateRequestSchema.parse(newRequest)).toEqual(newRequest);
  expect(legacy.parse(newRequest)).toEqual(oldRequest);
});

test("jj fetch-rebase additions remain optional and generated wire parsing retains native outcomes", () => {
  const legacy = {
    type: "checkout.jj.fetch_rebase.response",
    payload: {
      requestId: "fetch-rebase",
      cwd: "/native",
      success: true,
      changeId: "change",
      commitId: "commit",
      bookmark: null,
      error: null,
    },
  };
  const current = { ...legacy, payload: { ...legacy.payload, outcome: "unchanged" } };
  expect(CheckoutFetchRebaseResponseSchema.parse(legacy)).toEqual(legacy);
  const oldResponse = CheckoutFetchRebaseResponseSchema.extend({
    payload: CheckoutFetchRebaseResponseSchema.shape.payload.omit({ outcome: true }),
  });
  expect(oldResponse.parse(current)).toEqual(legacy);
  for (const message of [legacy, current]) {
    const envelope = { type: "session", message };
    expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: envelope });
  }
  const oldInfo = {
    status: "server_info",
    serverId: "host",
    hostname: null,
    version: null,
    features: { checkoutJj: true },
  };
  const currentInfo = {
    ...oldInfo,
    features: { ...oldInfo.features, checkoutJjFetchRebase: true },
  };
  expect(ServerInfoStatusPayloadSchema.parse(oldInfo)).toEqual(oldInfo);
  expect(ServerInfoStatusPayloadSchema.parse(currentInfo)).toEqual(currentInfo);
  const oldInfoSchema = z.object({
    status: z.literal("server_info"),
    serverId: z.string(),
    hostname: z.string().nullable(),
    version: z.string().nullable(),
    features: z.object({ checkoutJj: z.boolean().optional() }),
  });
  expect(oldInfoSchema.parse(currentInfo)).toEqual(oldInfo);
});

test("selected native PR command identities are optional across wire versions", () => {
  const identity = { host: "forge.example", targetRepository: "upstream/project", number: 42 };
  const merge = {
    type: "checkout_pr_merge_request",
    cwd: "/native",
    mergeMethod: "squash",
    requestId: "merge",
  };
  const auto = {
    type: "checkout.forge.set_auto_merge.request",
    cwd: "/native",
    enabled: false,
    requestId: "disable",
  };
  for (const request of [merge, auto]) {
    const current = { ...request, expectedPullRequest: identity };
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    expect(SessionInboundMessageSchema.parse(current)).toEqual(current);
  }
  expect(
    CheckoutPrMergeRequestSchema.omit({ expectedPullRequest: true }).parse({
      ...merge,
      expectedPullRequest: identity,
    }),
  ).toEqual(merge);
  expect(
    CheckoutForgeSetAutoMergeRequestSchema.omit({ expectedPullRequest: true }).parse({
      ...auto,
      expectedPullRequest: identity,
    }),
  ).toEqual(auto);
});
