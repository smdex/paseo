import { z } from "zod";

export class JcodeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JcodeError";
  }
}

export const envelopeSchema = z
  .object({
    v: z.literal(1),
    ev: z.string(),
    reply_to: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export const sessionSchema = z.object({
  session_id: z.string().min(1),
  working_dir: z.string().optional(),
  title: z.string().optional(),
  status: z.string(),
  parent_session_id: z.string().optional(),
  agent_label: z.string().optional(),
  swarm_status: z.string().optional(),
  updated_at_ms: z.number().optional(),
  last_active_at_ms: z.number().optional(),
  archived: z.boolean().optional(),
});
export const sessionsSchema = z.object({
  ev: z.literal("sessions"),
  sessions: z.array(sessionSchema),
});
export const attachedSchema = z.object({ ev: z.literal("attached"), session: sessionSchema });
export const helloSchema = z.object({
  ev: z.literal("hello_ok"),
  version: z.literal(1),
  capabilities: z.array(z.string()).default([]),
});
export const historySchema = z.object({
  ev: z.literal("history"),
  session_id: z.string(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      response_stats: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          cache_read_tokens: z.number().optional(),
        })
        .optional(),
    }),
  ),
});
export const runtimeSchema = z.object({
  ev: z.literal("runtime_info"),
  session_id: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  auth_method: z.string().optional(),
  reasoning_effort: z.string().optional(),
  routes: z.array(
    z.object({
      model: z.string(),
      provider: z.string(),
      api_method: z.string(),
      available: z.boolean(),
      detail: z.string(),
    }),
  ),
});
export const modelSchema = z.object({
  ev: z.literal("model_info"),
  session_id: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  auth_method: z.string().optional(),
  reasoning_effort: z.string().optional(),
});
export const persistenceSchema = z.object({ sessionId: z.string().min(1) }).strict();
export const streamSchema = z.discriminatedUnion("ev", [
  z.object({
    ev: z.literal("text_delta"),
    session_id: z.string(),
    text: z.string(),
    message_id: z.string().optional(),
  }),
  z.object({
    ev: z.literal("text_replace"),
    session_id: z.string(),
    text: z.string(),
    message_id: z.string().optional(),
  }),
  z.object({
    ev: z.literal("text_done"),
    session_id: z.string(),
    message_id: z.string().optional(),
  }),
  z.object({ ev: z.literal("reasoning_delta"), session_id: z.string(), text: z.string() }),
  z.object({ ev: z.literal("reasoning_done"), session_id: z.string() }),
  z.object({
    ev: z.literal("tool_start"),
    session_id: z.string(),
    call_id: z.string(),
    name: z.string(),
  }),
  z.object({
    ev: z.literal("tool_input_delta"),
    session_id: z.string(),
    call_id: z.string(),
    delta: z.string(),
  }),
  z.object({
    ev: z.literal("tool_exec"),
    session_id: z.string(),
    call_id: z.string(),
    name: z.string(),
  }),
  z.object({
    ev: z.literal("tool_call"),
    session_id: z.string(),
    call_id: z.string(),
    name: z.string(),
    input: z.json(),
  }),
  z.object({
    ev: z.literal("tool_done"),
    session_id: z.string(),
    call_id: z.string(),
    name: z.string(),
    output: z.string(),
    error: z.string().optional(),
  }),
  z.object({
    ev: z.literal("token_usage"),
    session_id: z.string(),
    input: z.number(),
    output: z.number(),
    cache_read_input: z.number().optional(),
  }),
  z.object({ ev: z.literal("turn_done"), session_id: z.string() }),
  z.object({
    ev: z.literal("turn_stopped"),
    session_id: z.string(),
    reason: z.string(),
    message: z.string(),
  }),
  z.object({ ev: z.literal("message_accepted"), session_id: z.string() }),
  z.object({ ev: z.literal("session_status"), session_id: z.string(), status: z.string() }),
  z.object({
    ev: z.literal("session_recovery"),
    session_id: z.string(),
    continuation_message: z.string(),
    reconnect_notice: z.string().optional(),
  }),
  z.object({ ev: z.literal("compacted"), session_id: z.string(), message: z.string() }),
  z.object({
    ev: z.literal("session_renamed"),
    session_id: z.string(),
    title: z.string().optional(),
    display_title: z.string(),
  }),
  modelSchema,
]);
export type NativeSession = z.infer<typeof sessionSchema>;
export type NativeStream = z.infer<typeof streamSchema>;
export type NativeFrame = z.infer<typeof envelopeSchema>;
