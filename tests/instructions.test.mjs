import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createInstructionContext, instructionSections, bonusSelectors } from "../dist/server/instruction-context.js";
import { createGooseRecipeAsset } from "../dist/server/config.js";

const sha = text => createHash("sha256").update(text).digest("hex");
function unpack(output) {
  const first = output.indexOf("\n");
  const second = output.indexOf("\n", first + 1);
  const meta = JSON.parse(output.slice(first + 1, second));
  const end = `\nEND_PAGE ${meta.page}/${meta.pages} ${meta.selection_sha256}\n`;
  assert.ok(output.startsWith(`BEGIN_PAGE ${meta.page}/${meta.pages} ${meta.selection_sha256}\n`));
  assert.ok(output.endsWith(end));
  const body = output.slice(second + 1, -end.length);
  assert.equal(Buffer.byteLength(body), meta.body_bytes);
  assert.equal(sha(body), meta.body_sha256);
  assert.ok(Buffer.byteLength(output) < 48_000);
  assert.ok(output.split("\n").length < 1900);
  return { meta, body };
}

test("heading index preserves the whole document and ignores fenced example headings", () => {
  const text = '---\nname: demo\n---\n# Root\nRules\n```sh\n## not a section\n```\n## Same\nRule A\n## Same\nRule B\n';
  const sections = instructionSections(text);
  assert.deepEqual(sections.map(s => s.title), ["Preamble", "Root", "Same", "Same"]);
  const lines = text.split(/(?<=\n)/);
  assert.equal(sections.map(s => lines.slice(s.start - 1, s.end).join("")).join(""), text);
});

test("bonus section route retains new rules and fails closed on missing/ambiguous skills", () => {
  const docs = ["mia3-identity", "mia3-conversation", "mia3-report", "mia3-analysis", "mia3-metrics", "mia3-catalog-motor"]
    .map(id => ({ id: `${id}--abc`, sections: [{ id: 1, title: "Mandatory rules" }, { id: 2, title: "New owner restriction" }] }));
  docs[2].sections.push({ id: 3, title: "Charts" });
  assert.equal(bonusSelectors(docs)[2], "mia3-report--abc:1,2");
  assert.ok(bonusSelectors(docs).every(selector => selector.endsWith(":1,2")));
  assert.equal(bonusSelectors(docs.slice(1)), null);
  assert.equal(bonusSelectors([...docs, docs[0]]), null);
});

test("bounded reader reconstructs Unicode/long-line documents, tracks completeness and detects changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goose-read-test-"));
  let asset;
  try {
    const text = '# Policy\n' + 'Значимый пункт 🪿\n'.repeat(3000) + 'Ж'.repeat(30000) + '\n## Final\nNever omit this rule.\n';
    await fs.writeFile(path.join(root, "skill.md"), text);
    asset = await createInstructionContext([{ id: "policy", file: path.join(root, "skill.md"), preload: true }]);
    assert.equal(asset.preloadedBytes, 0); // Oversize policy is indexed, never silently clipped.
    const invoke = argv => execFileSync("python3", [path.join(asset.localDir, "read-instructions.py"), ...argv], {
      env: { ...process.env, PAPERCLIP_INSTRUCTION_MANIFEST: path.join(asset.localDir, "manifest.json") }, encoding: "utf8", stdio: "pipe",
    });
    const first = unpack(invoke(["read", "--select", "policy"]));
    assert.equal(first.meta.complete, false);
    assert.ok(first.meta.next_page.includes("--page 2 --expect"));
    let joined = first.body;
    for (let i = 2; i <= first.meta.pages; i++) {
      const page = unpack(invoke(["read", "--select", "policy", "--page", String(i), "--expect", first.meta.selection_sha256]));
      assert.equal(page.meta.selection_byte_offset, Buffer.byteLength(joined));
      joined += page.body;
      assert.equal(page.meta.complete, i === first.meta.pages);
    }
    assert.equal(sha(joined), first.meta.selection_sha256);
    const reconstructed = joined.replace(/\nDOCUMENT policy sha256:[^\n]+\n/g, "");
    assert.equal(reconstructed, text);
    const section = unpack(invoke(["read", "--select", "policy:2"]));
    assert.ok(section.body.includes("Never omit this rule."));
    assert.ok(!section.body.includes("Значимый пункт"));
    for (const argv of [["read", "--select", "../other"], ["read", "--select", "policy:99"], ["read", "--select", "policy", "--page", "0"], ["read", "--select", "policy", "--expect", "bad"]]) {
      assert.throws(() => invoke(argv), /INSTRUCTION_READ_FAILED/);
    }
    await fs.appendFile(path.join(asset.localDir, "policy.md"), "new rule");
    assert.throws(() => invoke(["read", "--select", "policy"]), /checksum changed/);
  } finally {
    if (asset) await fs.rm(asset.localDir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bounded entry preload and index survive native Goose recipe rendering", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goose-index-test-"));
  let asset, recipe;
  try {
    const entry = '# Required\nAll rules, including "quotes" and {{ literal }}, remain.\n';
    await fs.writeFile(path.join(root, "entry.md"), entry);
    await fs.writeFile(path.join(root, "skill.md"), "# SQL\nCheck scope.\n## Delivery\nValidate the artifact.\n");
    asset = await createInstructionContext([{ id: "entry", file: path.join(root, "entry.md"), preload: true }, { id: "skill", file: path.join(root, "skill.md") }]);
    assert.ok(asset.instructions.includes(entry));
    assert.ok(asset.instructions.includes("skill: 1=SQL; 2=Delivery"));
    assert.ok(!asset.instructions.includes("Validate the artifact.")); // Index isn't advertised as loaded policy.
    recipe = await createGooseRecipeAsset({ mcpServers: [], provider: "ai-gate", model: "gpt-6-sol", maxTurns: 32,
      prompt: "Test task", instructions: asset.instructions, instructionIndex: true });
    if (process.env.GOOSE_TEST_BINARY) {
      execFileSync(process.env.GOOSE_TEST_BINARY, ["recipe", "validate", recipe.recipeFile], { stdio: "pipe" });
      const rendered = execFileSync(process.env.GOOSE_TEST_BINARY, ["run", "--recipe", recipe.recipeFile,
        "--params", `task=${recipe.localDir}/task.md`, "--params", `agent_context=${recipe.localDir}/instructions.md`, "--render-recipe"], { encoding: "utf8" });
      assert.ok(rendered.includes('{{ literal }}'));
      assert.ok(rendered.includes("END_DOCUMENT entry"));
    }
    assert.equal(await fs.readFile(path.join(root, "entry.md"), "utf8"), entry);
  } finally {
    for (const dir of [asset?.localDir, recipe?.localDir, root].filter(Boolean)) await fs.rm(dir, { recursive: true, force: true });
  }
});
