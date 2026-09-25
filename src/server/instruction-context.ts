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

// Only omit known, off-topic sections for a daily-bonus task. New headings are
// included by default, so updating a skill cannot silently drop a new rule.
const BONUS_OFF_TOPIC: Record<string, Set<string>> = {
  "mia3-report": new Set(["Tables in Slack", "Slack formatting", "Showing shape, not just numbers", "Charts", "A worked example"]),
  "mia3-metrics": new Set(["Deposits and withdrawals — from `Documents`", '"Hold" means cash hold', "Measured example — August 2026", "Bets, wins, GGR"]),
  "mia3-catalog-motor": new Set(["Country and device: coverage differs by brand, measure before you break down by them", "Segments — one definition, and it is not the obvious one", "Аффилиатка и VIP: и то и другое здесь есть"]),
};

export function bonusSelectors(docs: Array<{ id: string; sections: Array<{ id: number; title: string }> }>) {
  const core = ["mia3-identity", "mia3-conversation", "mia3-report", "mia3-analysis", "mia3-metrics", "mia3-catalog-motor"];
  const selected: string[] = [];
  for (const slug of core) {
    const candidates = docs.filter(d => d.id === slug || d.id.startsWith(`${slug}--`));
    if (candidates.length !== 1) return null;
    const doc = candidates[0];
    const sections = doc.sections.filter(s => !BONUS_OFF_TOPIC[slug]?.has(s.title)).map(s => s.id);
    selected.push(`${doc.id}:${sections.join(",")}`);
  }
  return selected;
}

export function instructionPages(text: string) {
  const pages: string[] = [];
  let chars: string[] = [], bytes = 0, lines = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 36_000 || (char === "\n" && lines >= 1_200)) {
      pages.push(chars.join(""));
      chars = []; bytes = 0; lines = 0;
    }
    chars.push(char); bytes += size; lines += Number(char === "\n");
  }
  if (chars.length || !pages.length) pages.push(chars.join(""));
  return pages;
}

/** A content-addressed per-run snapshot; no LLM summaries or policy rewriting. */
export async function createInstructionContext(documents: InstructionDocument[]) {
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-goose-context-"));
  try {
    await fs.copyFile(fileURLToPath(new URL("../../scripts/read-instructions.py", import.meta.url)), path.join(localDir, "read-instructions.py"));
    const docs: Array<{ id: string; file: string; sha256: string; bytes: number; loaded: boolean; sections: ReturnType<typeof instructionSections> }> = [];
    const texts = new Map<string, string[]>();
    const preloaded = [];
    const ids = new Set<string>();
    let preloadedBytes = 0;
    for (const input of documents) {
      if (!/^[\w-]+$/.test(input.id) || ids.has(input.id)) throw new Error("Invalid or duplicate instruction ID");
      ids.add(input.id);
      const text = await fs.readFile(input.file, "utf8");
      texts.set(input.id, text ? text.split(/(?<=\n)/) : []);
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
    const bonus = bonusSelectors(docs);
    const bundles: Record<string, { selectors: string[]; sha256: string; pages: Array<{ file: string; sha256: string; bytes: number }> }> = {};
    if (bonus) {
      const content = bonus.flatMap(selector => {
        const [id, sectionIds] = selector.split(":");
        const wanted = new Set(sectionIds.split(",").map(Number));
        const doc = docs.find(d => d.id === id)!;
        return doc.sections.filter(s => wanted.has(s.id)).map(s =>
          `\nDOCUMENT ${id} sha256:${doc.sha256} SECTION ${s.id} ${s.title} lines=${s.start}-${s.end}\n`
          + texts.get(id)!.slice(s.start - 1, s.end).join(""));
      }).join("");
      const pages = [];
      for (const [index, body] of instructionPages(content).entries()) {
        const file = `bonus-${index + 1}.txt`;
        await fs.writeFile(path.join(localDir, file), body, { mode: 0o600 });
        pages.push({ file, sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) });
      }
      bundles.bonus = { selectors: bonus, sha256: createHash("sha256").update(content).digest("hex"), pages };
    }
    const manifest = { version: 1, documents: docs, bundles };
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
      "Once page 1 reports the page count and selection hash, request ALL remaining pages as separate parallel shell calls (same selection, --page N --expect HASH). Every page must have both markers. Do not concatenate multiple pages into one shell output.",
      ...(bonus ? [
        "For a one-day Motor bonus-count/program-breakdown question, start with this complete section selection. It retains full identity/conversation/analysis rules and the relevant reporting, metrics and catalog sections; it omits only known off-topic deposits/GGR/VIP/geography/Slack-chart examples. New headings are included by default. Use the other sections when the question requires them. Entry/MAIN rules remain authoritative.",
        `All ${bundles.bonus.pages.length} pages are known now. Request them as SEPARATE PARALLEL shell tool calls in the same model turn, then verify every BEGIN/END marker. Do not wait for page 1 to discover the others:`,
        ...bundles.bonus.pages.map((_, i) => `python3 "$PAPERCLIP_INSTRUCTION_READER" read --bundle bonus --page ${i + 1} --expect ${bundles.bonus.sha256}`),
        "Do not additionally load mia3-lib or presentation implementation tutorials when using the already-validated daily helper and returned answer_helper; consult those documents if their operation fails or the output request goes beyond this procedure.",
      ] : []),
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
