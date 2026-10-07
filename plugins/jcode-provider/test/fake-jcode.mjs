import { appendFileSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const scenario = process.env.JCODE_TEST_SCENARIO || "normal";
function log(value) {
  if (process.env.JCODE_TEST_REQUESTS)
    appendFileSync(process.env.JCODE_TEST_REQUESTS, JSON.stringify(value) + "\n");
}
log({ args, env: { PASEO_AGENT_ID: process.env.PASEO_AGENT_ID, CUSTOM: process.env.CUSTOM } });
if (args.includes("--version")) {
  console.log("jcode v0.90.0");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log("--stdio");
  process.exit(0);
}
if (args.includes("model")) {
  console.log(
    JSON.stringify({
      provider: scenario.startsWith("opaque-catalog") ? "Z.AI" : "OpenAI",
      selected_model: "gpt-test",
      models: ["gpt-test"],
      routes: scenario.startsWith("opaque-catalog")
        ? [
            { provider: "Z.AI", model: "gpt-test", method: "api key", available: true },
            {
              provider: "Private Profile",
              model: "gpt-test",
              method: "api key",
              available: true,
            },
          ]
        : [
            { provider: "OpenAI", model: "gpt-test", method: "api key", available: true },
            { provider: "OpenAI", model: "gpt-test", method: "oauth", available: true },
          ],
    }),
  );
  process.exit(0);
}
let sessionId = "new-root";
let effort = "medium";
let model = "gpt-test";
let pendingAdmission = false;
function afterRelease(name, callback) {
  const marker = `${process.env.JCODE_TEST_REQUESTS}.${name}`;
  const release = () => {
    if (!existsSync(marker)) return;
    unwatchFile(marker);
    callback();
  };
  watchFile(marker, { interval: 10 }, release);
  release();
}
const capabilities = [
  "sessions",
  "streaming",
  "text_framing",
  "turn_stop_reasons",
  "persisted_session_discovery",
  "runtime_info",
  "session_archive",
  "session_tools",
];
if (scenario === "old-tools") capabilities.pop();
const saved = {
  session_id: "saved-root",
  working_dir: process.cwd(),
  title: "Terminal session",
  status: "idle",
  last_active_at_ms: 1700000000000,
};
function emit(ev, fields = {}, reply_to) {
  process.stdout.write(
    JSON.stringify({ v: 1, ev, ...fields, ...(reply_to === undefined ? {} : { reply_to }) }) + "\n",
  );
}
function finish() {
  emit("turn_done", { session_id: sessionId });
}
function output() {
  emit("text_delta", { session_id: sessionId, message_id: "message-1", text: "draft" });
  emit("reasoning_delta", { session_id: sessionId, text: "considering" });
  emit("reasoning_done", { session_id: sessionId });
  emit("tool_start", { session_id: sessionId, call_id: "read-1", name: "read" });
  emit("tool_input_delta", {
    session_id: sessionId,
    call_id: "read-1",
    delta: '{"file_path":"README.md"}',
  });
  emit("tool_exec", { session_id: sessionId, call_id: "read-1", name: "read" });
  emit("tool_done", { session_id: sessionId, call_id: "read-1", name: "read", output: "hello" });
  emit("text_replace", { session_id: sessionId, message_id: "message-1", text: "final" });
  emit("text_done", { session_id: sessionId, message_id: "message-1" });
  emit("token_usage", { session_id: sessionId, input: 12, output: 3, cache_read_input: 5 });
  if (scenario === "native-tool")
    emit("tool_call", {
      session_id: sessionId,
      call_id: "host-1",
      name: "create_agent",
      input: { prompt: "hello" },
    });
  else if (!["active", "delayed-admission", "cancel-failure"].includes(scenario)) finish();
}
createInterface({ input: process.stdin })
  // eslint-disable-next-line complexity -- Keep the fixture's wire request cases together for comparison with Jcode's translator.
  .on("line", (line) => {
    const req = JSON.parse(line);
    log(req);
    const fields = { session_id: sessionId };
    switch (req.req) {
      case "hello":
        emit("hello_ok", { version: 1, server: "fake", capabilities }, req.id);
        break;
      case "list_sessions":
        {
          const reply = () =>
            emit(
              "sessions",
              {
                sessions:
                  scenario === "opaque-catalog"
                    ? []
                    : [
                        saved,
                        ...(["children", "discovery-close"].includes(scenario)
                          ? [
                              {
                                session_id: "saved-child",
                                parent_session_id: "saved-root",
                                working_dir: process.cwd(),
                                title: "Worker",
                                agent_label: "worker",
                                status: "idle",
                                swarm_status: "completed",
                              },
                            ]
                          : []),
                      ],
              },
              req.id,
            );
          if (scenario === "discovery-close")
            afterRelease("release-discovery", () => {
              reply();
              log({ discovery_released: true });
            });
          else reply();
        }
        break;
      case "create_session":
        emit(
          "attached",
          { session: { session_id: sessionId, working_dir: req.working_dir, status: "idle" } },
          req.id,
        );
        break;
      case "attach_session":
        sessionId = req.session_id;
        emit(
          "attached",
          {
            session: {
              ...saved,
              session_id: sessionId,
              status: scenario === "busy-import" ? "processing" : "idle",
            },
          },
          req.id,
        );
        emit("session_status", {
          session_id: sessionId,
          status: scenario === "busy-import" ? "running" : "idle",
        });
        break;
      case "get_history":
        emit(
          "history",
          {
            ...fields,
            messages: [
              { role: "user", content: "old prompt" },
              { role: "assistant", content: "old response" },
              { role: "tool", content: "old tool output" },
            ],
          },
          req.id,
        );
        emit("session_status", {
          ...fields,
          status: scenario === "busy-import" ? "running" : "idle",
        });
        break;
      case "get_runtime_info":
        emit(
          "runtime_info",
          {
            ...fields,
            model,
            provider: "OpenAI",
            auth_method: "api_key",
            reasoning_effort: effort,
            routes:
              scenario === "opaque-catalog-existing"
                ? [
                    {
                      model,
                      provider: "Private Profile",
                      api_method: "openai-compatible:my-profile",
                      available: true,
                      detail: "",
                    },
                  ]
                : [
                    {
                      model,
                      provider: "OpenAI",
                      api_method: "openai-api-key",
                      available: true,
                      detail: "",
                    },
                  ],
          },
          req.id,
        );
        break;
      case "set_model":
        if (req.model === "invalid")
          emit("error", { code: "invalid_request", message: "Unknown model" }, req.id);
        else {
          model = req.model.replace(/^openai-api:/, "");
          emit("ok", {}, req.id);
          emit("model_info", {
            ...fields,
            model,
            provider: "OpenAI",
            reasoning_effort: effort,
            auth_method: "api_key",
          });
        }
        break;
      case "set_reasoning_effort":
        effort = req.effort;
        emit("ok", {}, req.id);
        emit("model_info", {
          ...fields,
          model,
          provider: "OpenAI",
          reasoning_effort: effort,
          auth_method: "api_key",
        });
        break;
      case "send_message":
        if (scenario === "rejected")
          emit(
            "error",
            { code: "invalid_request", message: "Already processing a message" },
            req.id,
          );
        else if (scenario === "delayed-admission") {
          pendingAdmission = true;
          emit("admission_pending", fields);
        } else {
          emit("message_accepted", fields);
          output();
        }
        break;
      case "soft_interrupt":
        emit("ok", {}, req.id);
        break;
      case "cancel":
        if (scenario === "cancel-failure") {
          emit("error", { code: "internal", message: "Cancel rejected" }, req.id);
          break;
        }
        emit("ok", {}, req.id);
        emit("turn_stopped", { ...fields, reason: "interrupted", message: "Canceled" });
        finish();
        break;
      case "compact":
        emit("compacted", { ...fields, message: "Compacted" }, req.id);
        break;
      case "rename_session":
        emit("ok", {}, req.id);
        emit("session_renamed", {
          ...fields,
          title: req.title,
          display_title: req.title || "Session",
        });
        break;
      case "tool_result":
        emit("ok", {}, req.id);
        finish();
        break;
      case "detach_session":
        if (scenario === "detach-failure")
          emit("error", { code: "internal", message: "Detach rejected" }, req.id);
        else if (scenario === "discovery-close" && sessionId === "saved-root")
          afterRelease("release-detach", () => emit("ok", {}, req.id));
        else emit("ok", {}, req.id);
        break;
      case "ping":
        if (pendingAdmission && req.release_admission) {
          pendingAdmission = false;
          emit("message_accepted", fields);
          output();
        }
        emit("pong", {}, req.id);
        break;
      default:
        emit("ok", {}, req.id);
    }
  })
  .on("close", () => {
    log({ bridge_closed: true, session_id: sessionId });
    process.exit(0);
  });
