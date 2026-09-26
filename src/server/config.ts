import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export interface GooseRuntimeMcpServer {
  name: string;
  url: string;
  token?: string;
  headers?: Record<string, string>;
  connectionId: string;
}

const DEFAULT_PROVIDER = "ai-gate";
const DEFAULT_MAIN_MODEL = "gpt-6-sol";
const DEFAULT_SUBAGENT_MODEL = "gpt-6-luna";

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

export function splitQualifiedModel(value: unknown, fallbackProvider = DEFAULT_PROVIDER): GooseModelSelection {
  const raw = stringValue(value);
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1) {
    const provider = raw.slice(0, slash).trim();
    const model = raw.slice(slash + 1).trim();
    return { provider, model, qualifiedModel: `${provider}/${model}` };
  }
  const model = raw || DEFAULT_MAIN_MODEL;
  return {
    provider: fallbackProvider || DEFAULT_PROVIDER,
    model,
    qualifiedModel: `${fallbackProvider || DEFAULT_PROVIDER}/${model}`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandEnvPlaceholders(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
      stringValue(env[name]) || match,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => expandEnvPlaceholders(entry, env));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandEnvPlaceholders(entry, env)]),
    );
  }
  return value;
}

function readMcpHeaders(value: unknown, env: Record<string, string>): Record<string, string> {
  if (!isRecord(value)) return {};
  const expanded = expandEnvPlaceholders(value, env);
  if (!isRecord(expanded)) return {};
  return Object.fromEntries(
    Object.entries(expanded).flatMap(([key, entry]) =>
      typeof entry === "string" && entry.trim() ? [[key, entry]] : [],
    ),
  );
}

function readOpenCodeMcpConfig(env: Record<string, string>): GooseRuntimeMcpServer[] {
  const raw = stringValue(env.PAPERCLIP_OPENCODE_MCP);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  return Object.entries(parsed).flatMap(([name, rawConfig]) => {
    if (!isRecord(rawConfig)) return [];
    const config = expandEnvPlaceholders(rawConfig, env);
    if (!isRecord(config)) return [];
    const url = stringValue(config.url);
    if (!url) return [];
    const headers = readMcpHeaders(config.headers, env);
    return [{
      name,
      url,
      headers,
      connectionId: `opencode:${name}`,
    }];
  });
}

function readBearerMcp(
  env: Record<string, string>,
  name: string,
  tokenKey: string,
  urlKey: string,
  defaultUrl: string,
): GooseRuntimeMcpServer[] {
  const token = stringValue(env[tokenKey]);
  if (!token) return [];
  return [{
    name,
    url: stringValue(env[urlKey]) || defaultUrl,
    token: token.replace(/^Bearer\s+/i, ""),
    connectionId: `env:${tokenKey}`,
  }];
}

export function mergeGooseRuntimeMcpServers(
  env: Record<string, string>,
  paperclipServers: GooseRuntimeMcpServer[],
): GooseRuntimeMcpServer[] {
  return [
    ...paperclipServers,
    ...readOpenCodeMcpConfig(env),
    ...readBearerMcp(
      env,
      "hex-data-mcp",
      "HEX_DATA_MCP_TOKEN",
      "HEX_DATA_MCP_URL",
      "https://hex-data-mcp.hexdrift-project.workers.dev/mcp",
    ),
    ...readBearerMcp(
      env,
      "hex-data-mcp-bq",
      "HEX_DATA_MCP_BQ_TOKEN",
      "HEX_DATA_MCP_BQ_URL",
      "https://hex-data-mcp-bq.hexdrift-project.workers.dev/mcp",
    ),
  ];
}

function recipeExtensionName(value: string, index: number): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || `paperclip-mcp-${index + 1}`;
}

function recipeHeaders(server: GooseRuntimeMcpServer): Record<string, string> {
  return server.headers ?? (server.token ? { Authorization: `Bearer ${server.token}` } : {});
}

export async function createGooseRecipeAsset(input: {
  mcpServers: GooseRuntimeMcpServer[];
  provider: string;
  model: string;
  maxTurns: number | null;
  prompt: string;
  instructions?: string;
  instructionIndex?: boolean;
  motorReportTool?: boolean;
}): Promise<{ localDir: string; recipeFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-goose-recipe-"));
  const recipeFile = path.join(root, "paperclip-motor.yaml");
  const recipe = {
    version: "1.0.0",
    title: "Paperclip automation",
    description: "Headless Paperclip workflow with explicit extensions.",
    parameters: [
      { key: "task", input_type: "file", requirement: "required", description: "Run-scoped task prompt" },
      ...(input.instructions ? [{ key: "agent_context", input_type: "file", requirement: "required", description: "Assigned instructions and skill documents" }] : []),
    ],
    instructions: [
      "You are running a headless Paperclip automation. Complete the supplied task using its assigned instructions and tools.",
      input.instructions
        ? input.instructionIndex
          ? "A versioned index and selected complete entry documents follow. Only documents explicitly marked loaded have been read; use PAPERCLIP_INSTRUCTION_READER for other required documents/sections and verify END_PAGE plus continuation markers. Never concatenate all skills into one shell response."
          : "The complete assigned instruction entry, MAIN.md and core analytical skills are included below. They have already been loaded: apply them without rereading those files. Read referenced files not included here when needed."
        : "Read PAPERCLIP_INSTRUCTIONS_PATH when set; relative instruction references resolve from its directory.",
      "PAPERCLIP_SKILLS_ROOT contains only this run's assigned skills. Use the provided paths rather than global filesystem or API discovery.",
      "Host paths /paperclip/.claude/skills in the copied instructions refer to PAPERCLIP_SKILLS_ROOT on this SSH worker.",
      "Respect the task's company scope, data guards and approval requirements. Report genuine blockers truthfully.",
    ].join("\n"),
    extensions: [
      {
        type: "platform",
        name: "developer",
        bundled: true,
        description: "Headless shell and file tools.",
      },
      ...(input.motorReportTool ? [{
        type: "stdio",
        name: "motor-report",
        description: "Run-scoped Motor context and guarded daily bonus report; no publication.",
        cmd: "python3",
        args: ["{{ recipe_dir }}/motor-report-mcp.py"],
        env_keys: [],
        envs: {},
        timeout: 120,
        available_tools: ["prepare_bonus_report"],
      }] : []),
      ...input.mcpServers.map((server, index) => ({
        type: "streamable_http",
        name: recipeExtensionName(server.name || server.connectionId, index),
        uri: server.url,
        headers: recipeHeaders(server),
        env_keys: [],
        envs: {},
        timeout: 300,
      })),
    ],
    settings: {
      goose_provider: input.provider === "ai-gate" ? "openai" : input.provider,
      goose_model: input.model,
      ...(input.maxTurns ? { max_turns: input.maxTurns } : {}),
    },
  };
  // Substitute arbitrary task text into a YAML block, not a quoted JSON value:
  // embedded quotes/newlines in a real task must not break the recipe parser.
  const yaml = Object.entries(recipe).filter(([key]) => key !== "instructions")
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")
    + `\ninstructions: |\n  ${recipe.instructions.replaceAll("\n", "\n  ")}\n`
    + (input.instructions ? "  {{ agent_context | indent(2) }}\n" : "")
    + "prompt: |\n  {{ task | indent(2) }}\n";
  await fs.writeFile(recipeFile, yaml, { mode: 0o600 });
  await fs.writeFile(path.join(root, "task.md"), input.prompt, { mode: 0o600 });
  if (input.instructions) await fs.writeFile(path.join(root, "instructions.md"), input.instructions, { mode: 0o600 });
  if (input.motorReportTool) await fs.copyFile(fileURLToPath(new URL("../../scripts/motor-report-mcp.py", import.meta.url)), path.join(root, "motor-report-mcp.py"));
  return { localDir: root, recipeFile };
}

export function resolveGooseRuntimeConfig(
  config: Record<string, unknown>,
): GooseRuntimeConfig {
  const env = config.env && typeof config.env === "object" && !Array.isArray(config.env)
    ? config.env as Record<string, unknown>
    : {};
  const configuredModel = firstNonEmpty(config.model, env.GOOSE_MODEL);
  const envProvider = firstNonEmpty(config.gooseProvider, env.GOOSE_PROVIDER);
  const main = splitQualifiedModel(configuredModel, envProvider || DEFAULT_PROVIDER);

  const configuredSubagentProvider = firstNonEmpty(config.subagentProvider, env.GOOSE_SUBAGENT_PROVIDER);
  const configuredSubagentModel = firstNonEmpty(
    config.subagentModel,
    env.GOOSE_SUBAGENT_MODEL,
    DEFAULT_SUBAGENT_MODEL,
  );
  const subagent = configuredSubagentModel
    ? splitQualifiedModel(configuredSubagentModel, configuredSubagentProvider || DEFAULT_PROVIDER)
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
    subagentProvider: subagent?.provider ?? DEFAULT_PROVIDER,
    subagentModel: subagent?.model ?? (configuredSubagentModel || null),
    providerName: firstNonEmpty(config.aiGateProviderName, env.AI_GATE_PROVIDER_NAME) || DEFAULT_PROVIDER,
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
  const mainUsesAiGate = runtime.provider === DEFAULT_PROVIDER;
  const subagentUsesAiGate = runtime.subagentProvider === DEFAULT_PROVIDER;
  next.GOOSE_PROVIDER = mainUsesAiGate ? "openai" : runtime.provider;
  next.GOOSE_MODEL = runtime.model;
  if (runtime.subagentProvider) {
    next.GOOSE_SUBAGENT_PROVIDER = subagentUsesAiGate ? "openai" : runtime.subagentProvider;
  }
  if (runtime.subagentModel) next.GOOSE_SUBAGENT_MODEL = runtime.subagentModel;
  if (mainUsesAiGate || subagentUsesAiGate) {
    const baseUrl = stringValue(env.AI_GATE_BASE_URL);
    if (baseUrl) {
      const normalized = baseUrl.replace(/\/+$/, "");
      const chatSuffix = "/v1/chat/completions";
      const v1Suffix = "/v1";
      if (normalized.endsWith(chatSuffix)) {
        next.OPENAI_HOST = normalized.slice(0, -chatSuffix.length) || normalized;
        next.OPENAI_BASE_PATH = "v1/chat/completions";
      } else if (normalized.endsWith(v1Suffix)) {
        next.OPENAI_HOST = normalized.slice(0, -v1Suffix.length) || normalized;
        next.OPENAI_BASE_PATH = "v1/chat/completions";
      } else {
        next.OPENAI_HOST = normalized;
        next.OPENAI_BASE_PATH = "v1/chat/completions";
      }
    }
    const apiKey = stringValue(env.AI_GATE_API_KEY);
    if (apiKey) next.OPENAI_API_KEY = apiKey;
  }
  if (!next.GOOSE_MODE) next.GOOSE_MODE = "auto";
  if (!next.GOOSE_DISABLE_SESSION_NAMING) next.GOOSE_DISABLE_SESSION_NAMING = "true";
  if (runtime.maxTurns && !next.GOOSE_MAX_TURNS) next.GOOSE_MAX_TURNS = String(runtime.maxTurns);
  return next;
}

function safeExtensionName(value: string, index: number): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `paperclip-${normalized || `mcp-${index + 1}`}`.slice(0, 80);
}

export async function createGooseRuntimeAsset(input: {
  mcpServers: GooseRuntimeMcpServer[];
}): Promise<{ localDir: string; mcpCount: number } | null> {
  if (input.mcpServers.length === 0) return null;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-goose-provider-"));
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { recursive: true });
  const extensions: Record<string, unknown> = {};
  for (const [index, server] of input.mcpServers.entries()) {
    const extensionName = safeExtensionName(server.name || server.connectionId, index);
    extensions[extensionName] = {
      type: "streamable_http",
      name: extensionName,
      enabled: true,
      uri: server.url,
      headers: server.headers ?? (server.token ? { Authorization: `Bearer ${server.token}` } : {}),
      env_keys: [],
      envs: {},
      timeout: 300,
    };
  }
  // JSON is valid YAML and avoids adding a YAML dependency to the adapter.
  // Goose reads this as config.yaml, while secrets remain confined to the
  // per-run staged runtime root and never enter prompts or logs.
  await fs.writeFile(
    path.join(configDir, "config.yaml"),
    `${JSON.stringify({ extensions }, null, 2)}\n`,
    "utf8",
  );
  return { localDir: root, mcpCount: input.mcpServers.length };
}

export async function createGooseInstructionsAsset(input: {
  instructionsRootPath: string;
  instructionsEntryFile?: string;
}): Promise<{ localDir: string; entryFile: string } | null> {
  const source = stringValue(input.instructionsRootPath);
  if (!source) return null;
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-goose-instructions-"));
  await fs.cp(source, root, { recursive: true, dereference: false });
  const requested = stringValue(input.instructionsEntryFile) || "AGENTS.md";
  const entryFile = requested.startsWith("/") ? path.basename(requested) : requested;
  const entryPath = path.join(root, entryFile);
  if (!(await fs.stat(entryPath).catch(() => null))?.isFile()) {
    await fs.rm(root, { recursive: true, force: true });
    return null;
  }
  return { localDir: root, entryFile };
}
