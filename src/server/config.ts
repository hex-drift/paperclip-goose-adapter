import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface GooseModelSelection {
  provider: string;
  model: string;
  qualifiedModel: string;
}

export interface GooseRuntimeConfig {
  provider: string;
  model: string;
  subagentProvider: string | null;
  subagentModel: string | null;
  providerName: string;
  aiGateBaseUrl: string | null;
  aiGateModels: string[];
  persistSession: boolean;
  maxTurns: number | null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

export function splitQualifiedModel(value: unknown, fallbackProvider = "ai-gate"): GooseModelSelection {
  const raw = stringValue(value);
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1) {
    const provider = raw.slice(0, slash).trim();
    const model = raw.slice(slash + 1).trim();
    return { provider, model, qualifiedModel: `${provider}/${model}` };
  }
  const model = raw || "gpt-5.6-luna";
  return {
    provider: fallbackProvider || "ai-gate",
    model,
    qualifiedModel: `${fallbackProvider || "ai-gate"}/${model}`,
  };
}

function parseModelList(value: unknown): string[] {
  const raw = stringValue(value);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .flatMap((entry) => (typeof entry === "string" ? [entry] : []))
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  } catch {
    // Comma-separated form is the normal environment-variable form.
  }
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function resolveGooseRuntimeConfig(
  config: Record<string, unknown>,
): GooseRuntimeConfig {
  const env = config.env && typeof config.env === "object" && !Array.isArray(config.env)
    ? config.env as Record<string, unknown>
    : {};
  const configuredModel = firstNonEmpty(config.model, env.GOOSE_MODEL);
  const envProvider = firstNonEmpty(config.gooseProvider, env.GOOSE_PROVIDER);
  const main = splitQualifiedModel(configuredModel, envProvider || "ai-gate");

  const configuredSubagentProvider = firstNonEmpty(config.subagentProvider, env.GOOSE_SUBAGENT_PROVIDER);
  const configuredSubagentModel = firstNonEmpty(config.subagentModel, env.GOOSE_SUBAGENT_MODEL);
  const subagent = configuredSubagentModel
    ? splitQualifiedModel(configuredSubagentModel, configuredSubagentProvider || main.provider)
    : null;

  const catalogModels = unique([
    ...parseModelList(config.aiGateModels),
    ...parseModelList(env.AI_GATE_MODELS),
    ...parseModelList(env.AI_GATE_MODELS_JSON),
    main.provider === "ai-gate" ? main.model : "",
    subagent?.provider === "ai-gate" ? subagent.model : "",
  ]);

  const maxTurnsRaw = Number(config.maxTurns ?? env.GOOSE_MAX_TURNS);
  const maxTurns = Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0 ? Math.trunc(maxTurnsRaw) : null;

  return {
    provider: main.provider,
    model: main.model,
    subagentProvider: subagent?.provider ?? (configuredSubagentProvider || null),
    subagentModel: subagent?.model ?? (configuredSubagentModel || null),
    providerName: firstNonEmpty(config.aiGateProviderName, env.AI_GATE_PROVIDER_NAME) || "ai-gate",
    aiGateBaseUrl: firstNonEmpty(config.aiGateBaseUrl, env.AI_GATE_BASE_URL) || null,
    aiGateModels: catalogModels,
    persistSession: config.persistSession === true || stringValue(env.GOOSE_PERSIST_SESSION).toLowerCase() === "true",
    maxTurns,
  };
}

export function applyGooseEnvironment(
  env: Record<string, string>,
  runtime: GooseRuntimeConfig,
): Record<string, string> {
  const next = { ...env };
  next.GOOSE_PROVIDER = runtime.provider;
  next.GOOSE_MODEL = runtime.model;
  if (runtime.subagentProvider) next.GOOSE_SUBAGENT_PROVIDER = runtime.subagentProvider;
  if (runtime.subagentModel) next.GOOSE_SUBAGENT_MODEL = runtime.subagentModel;
  if (!next.GOOSE_MODE) next.GOOSE_MODE = "auto";
  if (!next.GOOSE_DISABLE_SESSION_NAMING) next.GOOSE_DISABLE_SESSION_NAMING = "true";
  if (runtime.maxTurns && !next.GOOSE_MAX_TURNS) next.GOOSE_MAX_TURNS = String(runtime.maxTurns);
  return next;
}

export async function createAiGateProviderAsset(input: {
  runtime: GooseRuntimeConfig;
}): Promise<{ localDir: string; providerName: string } | null> {
  if (input.runtime.providerName !== "ai-gate" || !input.runtime.aiGateBaseUrl) return null;
  if (input.runtime.aiGateModels.length === 0) return null;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-goose-provider-"));
  const providerDir = path.join(root, "config", "custom_providers");
  await fs.mkdir(providerDir, { recursive: true });
  const provider = {
    name: input.runtime.providerName,
    engine: "openai",
    display_name: "AI Gate",
    description: "Paperclip-provided AI Gate catalog",
    api_key_env: "AI_GATE_API_KEY",
    base_url: input.runtime.aiGateBaseUrl,
    models: input.runtime.aiGateModels.map((name) => ({ name, context_limit: 200000 })),
    supports_streaming: true,
    requires_auth: true,
  };
  await fs.writeFile(
    path.join(providerDir, `${input.runtime.providerName}.json`),
    `${JSON.stringify(provider, null, 2)}\n`,
    "utf8",
  );
  return { localDir: root, providerName: input.runtime.providerName };
}
