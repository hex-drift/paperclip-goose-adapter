import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface InstructionDocument {
  id: string;
  file: string;
  /** Only small, mandatory entry documents belong in the initial context. */
  preload?: boolean;
}

export function instructionSections(text: string) {
  const lines = text ? text.split(/(?<=\n)/) : [];
  const starts: Array<{ start: number; title: string }> = [{ start: 0, title: "Preamble" }];
  let fence: string | null = null;
  for (const [index, line] of lines.entries()) {
    const fenced = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenced) {
      if (!fence) fence = fenced[1];
      else if (fenced[1][0] === fence[0] && fenced[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (index === 0) starts[0] = { start: 0, title: heading[1] };
      else starts.push({ start: index, title: heading[1] });
    }
  }
  return starts.map((section, index) => ({
    id: index + 1, title: section.title,
    start: section.start + 1,
    end: starts[index + 1]?.start ?? lines.length,
  }));
}

/** A content-addressed per-run snapshot; no LLM summaries or policy rewriting. */
export async function createInstructionContext(documents: InstructionDocument[]) {
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-goose-context-"));
  try {
    await fs.copyFile(fileURLToPath(new URL("../../scripts/read-instructions.py", import.meta.url)), path.join(localDir, "read-instructions.py"));
    const docs = [];
    const preloaded = [];
    const ids = new Set<string>();
    let preloadedBytes = 0;
    for (const input of documents) {
      if (!/^[\w-]+$/.test(input.id) || ids.has(input.id)) throw new Error("Invalid or duplicate instruction ID");
      ids.add(input.id);
      const text = await fs.readFile(input.file, "utf8");
      const sha256 = createHash("sha256").update(text).digest("hex");
      const file = `${input.id}.md`;
      await fs.writeFile(path.join(localDir, file), text, { mode: 0o600 });
      const loaded = input.preload === true && preloadedBytes + Buffer.byteLength(text) <= 32_000;
      if (loaded) {
        preloadedBytes += Buffer.byteLength(text);
        preloaded.push(`## Loaded ${input.id} (sha256:${sha256})\nBEGIN_DOCUMENT ${input.id}\n${text}\nEND_DOCUMENT ${input.id}`);
      }
      docs.push({ id: input.id, file, sha256, bytes: Buffer.byteLength(text), loaded,
        sections: instructionSections(text) });
    }
    const manifest = { version: 1, documents: docs };
    const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    await fs.writeFile(path.join(localDir, "manifest.json"), JSON.stringify({ ...manifest, digest }), { mode: 0o600 });
    const index = docs.map(doc => `- ${doc.id}${doc.loaded ? " [already loaded in full]" : ""}: `
      + doc.sections.map(s => `${s.id}=${s.title}`).join("; ")).join("\n");
    const instructions = [
      `## Assigned instruction index v1 / ${digest}`,
      "The entry documents marked loaded below are complete verbatim snapshots; apply them without rereading them. The other documents are indexed, NOT yet read.",
      'Read required skills/sections with `python3 "$PAPERCLIP_INSTRUCTION_READER" read --select DOC[:SECTION,SECTION] ...`. Omitting sections reads the full document. Select relevant sections according to the mandatory entry rules; do not treat the index as the policy itself.',
      `Example: python3 "$PAPERCLIP_INSTRUCTION_READER" read --select ${docs.find(d => !d.loaded)?.id ?? docs[0]?.id ?? "DOC"}`,
      "Each response is bounded below Goose's 50,000-byte/2,000-line shell limit. It has BEGIN_PAGE/END_PAGE markers, source checksums, line ranges and an explicit next-page command. If incomplete, follow next_page before treating the requested selection as read. Do not pipe the reader through head/tail or combine its output with another large command.",
      'For a larger index use `python3 "$PAPERCLIP_INSTRUCTION_READER" index --doc DOC`. Files and original rules remain available; a changed source fails the checksum instead of silently using stale instructions.',
      "Treat quoted examples/history in the documents as such. Runtime path mapping: use PAPERCLIP_SKILLS_ROOT in place of host /paperclip/.claude/skills; MIA/LIB are already resolved and company-checked. Relative entry references use the directory of PAPERCLIP_INSTRUCTIONS_PATH.",
      index.length <= 14_000 ? index : docs.map(d => `- ${d.id}${d.loaded ? " [loaded]" : ""}: ${d.sections.length} sections (use index --doc)`).join("\n"),
      ...preloaded,
    ].join("\n\n");
    return { localDir, instructions, digest, documentCount: docs.length, preloadedBytes };
  } catch (error) {
    await fs.rm(localDir, { recursive: true, force: true });
    throw error;
  }
}
