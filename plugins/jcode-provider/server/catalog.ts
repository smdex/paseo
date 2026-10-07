import { execCommand } from "@getpaseo/plugin/server";
import type {
  ProviderCatalog,
  ProviderConfigState,
  ProviderLaunch,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { attachedSchema, runtimeSchema, sessionsSchema } from "./wire.js";
import { Connection } from "./connection.js";

const cliCatalogSchema = z.object({
  provider: z.string(),
  selected_model: z.string(),
  models: z.array(z.string()),
  routes: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      method: z.string(),
      available: z.boolean(),
    }),
  ),
});
const effortLabels: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  swarm: "Swarm",
  "swarm-deep": "Deep swarm",
};

// ponytail: harness v1 omits per-model effort ladders. Match Jcode's remote UI inference;
// the runtime remains authoritative and rejects unsupported model-specific values.
export function thinkingOptions(
  provider: string | undefined,
  model: string | undefined,
): ProviderThinkingOption[] {
  const identity = `${provider ?? ""} ${model ?? ""}`.toLowerCase();
  let values: string[] = [];
  if (/openrouter/.test(identity))
    values = ["none", "minimal", "low", "medium", "high", "xhigh", "swarm", "swarm-deep"];
  else if (/openai-compatible/.test(provider ?? "") && !/gpt-|^o[1-9]/.test(model ?? ""))
    values = [];
  else if (/anthropic|claude/.test(identity)) values = claudeEfforts(model ?? "");
  else if (/deepseek/.test(identity))
    values = ["none", "low", "medium", "high", "max", "swarm", "swarm-deep"];
  else if (/openai|codex|gpt-|glm-|zai|z\.ai/.test(identity)) values = Object.keys(effortLabels);
  return values.map((id) => ({
    id,
    label: effortLabels[id]!,
    description: id.startsWith("swarm")
      ? "Jcode orchestration mode, not a model reasoning budget"
      : undefined,
  }));
}

function claudeEfforts(model: string): string[] {
  const normalized = model.toLowerCase().replaceAll(".", "-");
  const version = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(normalized) ?? [];
  const family = version[1] ?? "";
  const generation = Number(version[2] ?? 0) * 100 + Number(version[3] ?? 0);
  const full = generation >= 500 || (family === "opus" && generation >= 407);
  const max =
    full ||
    normalized.includes("mythos") ||
    (generation === 406 && ["opus", "sonnet"].includes(family));
  const manual = ["opus:405", "sonnet:307"].includes(`${family}:${generation}`);
  if (!full && !max && !manual) return [];
  return [
    "none",
    "low",
    "medium",
    "high",
    ...(full ? ["xhigh"] : []),
    ...(max ? ["max"] : []),
    "swarm",
    "swarm-deep",
  ];
}

export function routeModel(model: string, provider: string, method: string): string {
  const key = method.toLowerCase();
  const name = provider.toLowerCase();
  const credential = `${name}:${key}`;
  const prefixes: Record<string, string> = {
    "anthropic:oauth": "claude-oauth",
    "claude:oauth": "claude-oauth",
    "anthropic:api key": "claude-api",
    "claude:api key": "claude-api",
    "openai:oauth": "openai-oauth",
    "openai:api key": "openai-api",
  };
  const nativePrefixes: Record<string, string> = {
    "claude-oauth": "claude-oauth",
    "anthropic-api-key": "claude-api",
    "openai-oauth": "openai-oauth",
    "openai-api-key": "openai-api",
  };
  if (key === "grok-build-acp") return `grok-build:${model.replace(/^grok-build:/, "")}`;
  const authPrefix = nativePrefixes[key] ?? prefixes[credential];
  if (authPrefix) return `${authPrefix}:${model}`;
  const profile = /^openai-compatible:(.+)$/.exec(method);
  if (profile) return `${profile[1]}:${model}`;
  if (["copilot", "cursor", "bedrock", "grok-build", "antigravity-https", "https"].includes(key)) {
    const prefix = key === "https" || key === "antigravity-https" ? "antigravity" : key;
    return `${prefix}:${model}`;
  }
  if (key === "openrouter") {
    let catalogId = model;
    if (!model.includes("/")) {
      if (model.startsWith("claude-")) catalogId = `anthropic/${model}`;
      if (model.startsWith("gpt-") || /^o[1-9]/.test(model)) catalogId = `openai/${model}`;
    }
    const routedProvider = provider.replace(/^OpenRouter\//, "");
    if (routedProvider === "auto" || routedProvider === "OpenRouter" || catalogId.includes("@"))
      return catalogId;
    return `${catalogId}@${routedProvider}`;
  }
  return model;
}

export async function readCatalog(launch: ProviderLaunch, cwd?: string): Promise<ProviderCatalog> {
  const { stdout } = await execCommand(
    launch.command,
    [...launch.args, "--quiet", "--no-update", "model", "list", "--json"],
    { env: launch.env, cwd, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
  );
  const catalog = cliCatalogSchema.parse(JSON.parse(stdout));
  const models = new Map<string, ProviderModel>();
  for (const [index, route] of catalog.routes.entries()) {
    const opaque =
      route.method === "api key" &&
      !["openai", "anthropic", "claude"].includes(route.provider.toLowerCase());
    const id = opaque
      ? `unresolved:${index}:${route.provider}:${route.model}`
      : routeModel(route.model, route.provider, route.method);
    models.set(id, {
      id,
      label: `${route.model} (${route.provider}, ${route.method})`,
      isSelectable: route.available && !opaque,
      description: opaque
        ? "Attach a session to discover the exact configured profile route"
        : undefined,
      metadata: { provider: route.provider, method: route.method },
      thinkingOptions: thinkingOptions(route.provider, route.model),
    });
  }
  for (const id of catalog.models) {
    if (!catalog.routes.some((route) => route.model === id)) models.set(id, { id, label: id });
  }
  // The CLI omits the selected authentication method. Do not guess between API and OAuth.
  const defaultModel = catalog.selected_model;
  if (!models.has(defaultModel))
    models.set(defaultModel, { id: defaultModel, label: `${defaultModel} (Jcode default route)` });
  if ([...models.keys()].some((id) => id.startsWith("unresolved:"))) {
    const exactModels = await readNativeModels(launch, cwd);
    if (exactModels) {
      for (const id of models.keys()) if (id.startsWith("unresolved:")) models.delete(id);
      for (const model of exactModels) models.set(model.id, model);
    }
  }
  return {
    models: [...models.values()],
    defaultModel,
    modes: [],
    thinkingOptions: thinkingOptions(catalog.provider, catalog.selected_model),
  };
}

async function readNativeModels(
  launch: ProviderLaunch,
  cwd?: string,
): Promise<readonly ProviderModel[] | null> {
  const host = new Connection(launch, cwd);
  try {
    await host.initialize();
    const listed = await host.request("list_sessions", { limit: 1 }, sessionsSchema);
    const native = listed.sessions[0];
    if (!native) return null;
    await host.request("attach_session", { session_id: native.session_id }, attachedSchema);
    const runtime = await host.request(
      "get_runtime_info",
      { session_id: native.session_id },
      runtimeSchema,
    );
    return runtimeConfig(runtime).models;
  } catch {
    // CLI labels lose custom profile IDs. Keep them disabled when no existing session
    // can supply native metadata. Never create a probe or mutate a saved session.
    return null;
  } finally {
    await host.close();
  }
}

export function runtimeConfig(runtime: z.infer<typeof runtimeSchema>): ProviderConfigState {
  const models = runtime.routes.map((route) => ({
    id: routeModel(route.model, route.provider, route.api_method),
    label: `${route.model} (${route.provider}, ${route.api_method})`,
    isSelectable: route.available,
    description: route.detail,
    metadata: { provider: route.provider, method: route.api_method },
    thinkingOptions: thinkingOptions(route.provider, route.model),
  }));
  return {
    model: selectedModel(runtime) ?? runtime.model,
    thinkingOption: runtime.reasoning_effort,
    models,
    modes: [],
    thinkingOptions: thinkingOptions(runtime.provider, runtime.model),
    settings: [],
  };
}

export function selectedModel(runtime: {
  model?: string;
  provider?: string;
  auth_method?: string;
  routes?: Array<{ model: string; provider: string; api_method: string }>;
}): string | undefined {
  if (!runtime.model || !runtime.provider) return runtime.model;
  const method = runtime.auth_method === "api_key" ? "api key" : runtime.auth_method;
  if (method) return routeModel(runtime.model, runtime.provider, method);
  const routes = runtime.routes?.filter(
    (route) => route.model === runtime.model && route.provider === runtime.provider,
  );
  if (routes?.length === 1)
    return routeModel(runtime.model, runtime.provider, routes[0]!.api_method);
  return runtime.model;
}
