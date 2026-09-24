type ParserRecord = Record<string, unknown>;
type TranscriptEntry = Record<string, unknown>;

function asRecord(value: unknown): ParserRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ParserRecord
    : null;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const record = asRecord(entry);
      return record ? String(record.text ?? record.content ?? "") : String(entry ?? "");
    }).join("");
  }
  const record = asRecord(value);
  return record ? String(record.text ?? record.content ?? record.output ?? "") : "";
}

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }
  const record = asRecord(event);
  if (!record) return [{ kind: "stdout", ts, text: line }];
  const type = String(record.type ?? record.event ?? record.kind ?? "").toLowerCase();
  if (/error|failed/.test(type)) {
    return [{ kind: "stderr", ts, text: textValue(record.error ?? record.message ?? record.data) || "Goose error" }];
  }
  if (/thought|reasoning|thinking/.test(type)) {
    const text = textValue(record.text ?? record.delta ?? record.content ?? record.data);
    return text ? [{ kind: "thinking", ts, text, delta: true }] : [];
  }
  const message = asRecord(record.message);
  const text = textValue(record.text ?? record.delta ?? record.content ?? record.output ?? record.response ?? record.result ?? record.data ?? message?.content);
  if (text && (/assistant|message|text|response|result|final/.test(type) || message?.role === "assistant")) {
    return [{ kind: "assistant", ts, text, delta: true }];
  }
  if (/tool|function/.test(type)) {
    return [{
      kind: "tool_call",
      ts,
      name: String(record.name ?? record.tool ?? "goose tool"),
      input: record.input ?? {},
      toolUseId: String(record.tool_call_id ?? record.toolUseId ?? `${ts}:goose-tool`),
    }];
  }
  if (type === "done" || type === "complete" || type === "end") {
    return [{ kind: "system", ts, text: "Goose run completed" }];
  }
  return [{ kind: "system", ts, text: `event: ${type || "unknown"}` }];
}

export function createStdoutParser() {
  return { parseLine: parseStdoutLine, reset() {} };
}
