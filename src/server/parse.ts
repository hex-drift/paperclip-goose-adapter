export interface ParsedGooseStream {
  sessionId: string | null;
  summary: string;
  thought: string;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value).trim();
    if (text) return text;
  }
  return "";
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const item = record(entry);
      return item ? rawText(item.text, item.content, item.output) : stringValue(entry);
    }).join("");
  }
  const item = record(value);
  return item ? rawText(item.text, item.content, item.output, item.delta) : "";
}

// Streaming chunks include leading spaces; trimming each one joins every word.
function rawText(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string") ?? "";
}

function eventText(event: Record<string, unknown>, type: string): string {
  const message = record(event.message);
  const role = firstString(event.role, message?.role).toLowerCase();
  if (role && role !== "assistant") return "";
  const assistantEvent = role === "assistant" || /assistant|message|text|response|result|final/i.test(type);
  if (!assistantEvent) return "";
  return contentText(
    event.text ??
      event.delta ??
      event.content ??
      event.output ??
      event.response ??
      event.result ??
      event.data ??
      message?.content ??
      message?.text,
  );
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]): number {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function parseGooseStreamJson(stdout: string): ParsedGooseStream {
  let sessionId: string | null = null;
  let errorMessage: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd: number | null = null;
  const summaryParts: string[] = [];
  const thoughtParts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = record(parsed);
    if (!event) continue;
    const type = firstString(event.type, event.event, event.kind).toLowerCase();
    sessionId = firstString(event.session_id, event.sessionId, event.sessionID) || sessionId;

    const usage = record(event.usage ?? event.token_usage ?? event.tokens);
    inputTokens = usageNumber(usage, "input_tokens", "inputTokens", "prompt_tokens") || inputTokens;
    outputTokens = usageNumber(usage, "output_tokens", "outputTokens", "completion_tokens") || outputTokens;
    cachedInputTokens = usageNumber(usage, "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens") || cachedInputTokens;
    const cost = event.cost_usd ?? event.costUsd ?? event.total_cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost)) costUsd = cost;

    const error = firstString(event.error, event.error_message, event.errorMessage, event.message && typeof event.message === "string" ? event.message : "");
    if (/error|failed/i.test(type) && error) errorMessage = error;

    const text = eventText(event, type);
    if (!text) continue;
    if (/thought|reasoning|thinking/i.test(type)) thoughtParts.push(text);
    else summaryParts.push(text);
  }

  return {
    sessionId,
    summary: summaryParts.join("").trim(),
    thought: thoughtParts.join("").trim(),
    errorMessage,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsd,
  };
}
