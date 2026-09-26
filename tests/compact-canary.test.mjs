import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { compactBonusCanary } from "../dist/server/compact-canary.js";

const sha = value => createHash("sha256").update(value).digest("hex");

test("compact canary needs exact source/pack hashes and falls back on drift", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goose-canary-"));
  try {
    const ids = ["agent-entry", "agent-main", "mia3-identity--v", "mia3-conversation--v",
      "mia3-analysis--v", "mia3-report--v", "mia3-metrics--v", "mia3-catalog-motor--v", "mia3-lib--v"];
    const documents = await Promise.all(ids.map(async id => {
      const file = path.join(root, `${id}.md`);
      await fs.writeFile(file, `# ${id}\n`);
      return { id, file };
    }));
    const contract = "Full owner-approved contract.";
    const dailyBonus = "Full owner-approved daily rules.";
    const issue = { id: "motor-issue", title: "Motor bonuses 2026-09-24", description: "Count awarded bonuses for Motor on 2026-09-24 UTC." };
    const pack = {
      version: 1, approved: true, agentId: "motor-agent", companyId: "motor-company",
      issueId: issue.id, titleSha256: sha(issue.title), descriptionSha256: sha(issue.description),
      contract, dailyBonus, contractSha256: sha(contract), dailyBonusSha256: sha(dailyBonus),
      sourceSha256: Object.fromEntries(await Promise.all(documents.map(async doc => [doc.id, sha(await fs.readFile(doc.file))]))),
    };
    const packPath = path.join(root, "pack.json");
    const run = (overrides = {}) => compactBonusCanary({ enabled: true, packPath, agentId: "motor-agent",
      companyId: "motor-company", issueId: issue.id, wakeReason: "issue_assigned", issue,
      documents, fullInstructions: "FULL INDEX", ...overrides });
    await fs.writeFile(packPath, JSON.stringify(pack));
    const active = await run();
    assert.equal(active.active, true);
    assert.ok(active.instructions.includes(dailyBonus));
    assert.ok(active.instructions.includes("$PAPERCLIP_INSTRUCTION_READER"));
    assert.deepEqual(await run({ wakeReason: "issue_comment" }), { active: false, instructions: "FULL INDEX" });
    assert.deepEqual(await run({ issue: { ...issue, description: "And include a second question." } }),
      { active: false, instructions: "FULL INDEX" });
    assert.deepEqual(await run({ issue: { ...issue, title: "Other report" } }),
      { active: false, instructions: "FULL INDEX" });
    await fs.appendFile(documents[2].file, "new rule");
    assert.deepEqual(await run(), { active: false, instructions: "FULL INDEX" });
    await fs.writeFile(documents[2].file, `# ${documents[2].id}\n`);
    await fs.writeFile(packPath, JSON.stringify({ ...pack, dailyBonus: "unreviewed change" }));
    assert.deepEqual(await run(), { active: false, instructions: "FULL INDEX" });
    await fs.writeFile(packPath, JSON.stringify({ ...pack, agentId: "other-agent" }));
    assert.deepEqual(await run(), { active: false, instructions: "FULL INDEX" });
    await fs.writeFile(packPath, JSON.stringify({ ...pack, sourceSha256: { ...pack.sourceSha256, "mia3-lib--v": undefined } }));
    assert.deepEqual(await run(), { active: false, instructions: "FULL INDEX" });
    assert.deepEqual(await run({ enabled: false }), { active: false, instructions: "FULL INDEX" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
