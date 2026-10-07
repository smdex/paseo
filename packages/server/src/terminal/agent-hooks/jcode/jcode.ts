import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { jcodeHooksFormat } from "./jcode-settings.js";

const JCODE_EVENT_STATES: Record<string, AgentHookActivityState> = {
  session_start: "running",
  post_tool: "running",
  turn_end: "idle",
  session_end: "idle",
};

export const jcodeAgentHookProvider: AgentHookProvider<string> = {
  id: "jcode",
  events: [
    { event: "session_start" },
    { event: "post_tool" },
    { event: "turn_end" },
    { event: "session_end" },
  ],
  install: {
    kind: "config-file",
    configDir: ".jcode",
    configFile: "config.toml",
    configDirEnvOverride: "JCODE_HOME",
    hookMarker: "hooks jcode",
    format: jcodeHooksFormat,
  },
  async resolveActivity({ event }) {
    return JCODE_EVENT_STATES[event] ?? null;
  },
};
