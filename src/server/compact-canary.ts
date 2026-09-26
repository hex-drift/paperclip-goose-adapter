import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { InstructionDocument } from "./instruction-context.js";

const CORE = ["mia3-identity", "mia3-conversation", "mia3-analysis", "mia3-report", "mia3-metrics", "mia3-catalog-motor"];
const SHA256 = /^[a-f0-9]{64}$/;

/** Explicit, hash-pinned experiment; a mismatch always retains the full indexed instructions. */
export async function compactBonusCanary(input: {
  enabled: boolean;
  packPath: string;
  agentId: string;
  companyId: string;
  issueId: string;
  wakeReason: string;
  issue: unknown;
  documents: InstructionDocument[];
  fullInstructions: string;
}): Promise<{ instructions: string; active: boolean }> {
  const fallback = { instructions: input.fullInstructions, active: false };
  if (!input.enabled || !input.packPath || !path.isAbsolute(input.packPath)) return fallback;
  try {
    const pack: unknown = JSON.parse(await fs.readFile(input.packPath, "utf8"));
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) return fallback;
    const p = pack as Record<string, unknown>;
    if (!input.issue || typeof input.issue !== "object" || Array.isArray(input.issue)) return fallback;
    const issue = input.issue as Record<string, unknown>;
    if (p.version !== 1 || p.agentId !== input.agentId || p.companyId !== input.companyId
      || p.issueId !== input.issueId || !input.issueId || input.wakeReason !== "issue_assigned"
      || issue.id !== input.issueId || typeof issue.title !== "string"
      || typeof issue.description !== "string" || typeof p.titleSha256 !== "string"
      || typeof p.descriptionSha256 !== "string" || !SHA256.test(p.titleSha256)
      || !SHA256.test(p.descriptionSha256)
      || p.approved !== true || typeof p.contract !== "string" || typeof p.dailyBonus !== "string"
      || typeof p.contractSha256 !== "string" || typeof p.dailyBonusSha256 !== "string"
      || !SHA256.test(p.contractSha256) || !SHA256.test(p.dailyBonusSha256)
      || !p.contract.trim() || !p.dailyBonus.trim()) return fallback;
    if (createHash("sha256").update(issue.title).digest("hex") !== p.titleSha256
      || createHash("sha256").update(issue.description).digest("hex") !== p.descriptionSha256) return fallback;
    if (createHash("sha256").update(p.contract).digest("hex") !== p.contractSha256
      || createHash("sha256").update(p.dailyBonus).digest("hex") !== p.dailyBonusSha256) return fallback;
    const hashes = p.sourceSha256;
    if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) return fallback;
    const expected = hashes as Record<string, unknown>;
    const required = ["agent-entry", "agent-main", ...CORE];
    if (input.documents.length < required.length) return fallback;
    const selected = new Map<string, InstructionDocument>();
    for (const doc of input.documents) {
      const key = required.includes(doc.id) ? doc.id : CORE.find(slug => doc.id === slug || doc.id.startsWith(`${slug}--`));
      if (key) {
        if (selected.has(key)) return fallback;
        selected.set(key, doc);
      }
    }
    if (selected.size !== required.length || Object.keys(expected).length !== input.documents.length) return fallback;
    for (const doc of input.documents) {
      const sha = expected[doc.id];
      if (typeof sha !== "string" || !SHA256.test(sha)) return fallback;
      const actual = createHash("sha256").update(await fs.readFile(doc.file)).digest("hex");
      if (actual !== sha) return fallback;
    }
    const content = [p.contract, p.dailyBonus].join("\n\n");
    if (Buffer.byteLength(content) > 32_000) return fallback;
    return {
      active: true,
      instructions: [
        `## Owner-approved Motor daily bonus canary (sha256:${createHash("sha256").update(content).digest("hex")})`,
        "Apply the following contract and daily-bonus rules only for the one-day Motor bonus question. For any other scope or follow-up, read the original documents in full before proceeding.",
        content,
        "The complete original, hash-checked documents remain available at $PAPERCLIP_INSTRUCTION_MANIFEST. Read required documents with `python3 \"$PAPERCLIP_INSTRUCTION_READER\" read --select DOC` and follow every next_page; verify END_PAGE on each page. For other tasks, consult MAIN and every required skill; this pack does not replace them.",
        ...input.documents.map(doc => `- ${doc.id}: sha256:${expected[doc.id]}`),
      ].join("\n\n"),
    };
  } catch {
    return fallback;
  }
}
