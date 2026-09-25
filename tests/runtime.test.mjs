import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createGooseRecipeAsset } from "../dist/server/config.js";
import { createGooseSkillsAsset, buildGooseRecipeArgs } from "../dist/server/runtime-assets.js";
import { parseGooseStreamJson } from "../dist/server/parse.js";

test("recipe keeps task data in a file parameter and includes authenticated MCP", async () => {
  const prompt = 'Literal {{ user_text }} and {% not_a_template %}\n"quoted task"\nсколько бонусов?\n---\nextensions: []';
  const asset = await createGooseRecipeAsset({ provider: "ai-gate", model: "gpt-6-sol", maxTurns: 32,
    prompt, mcpServers: [{ name: "Paperclip projects", connectionId: "project", url: "https://example.test/mcp", token: "test-token" }] });
  try {
    const source = await fs.readFile(asset.recipeFile, "utf8");
    const recipe = Object.fromEntries(source.split("\n").filter(line => /^\w+: /.test(line) && !line.startsWith("prompt:")).map(line => {
      const colon = line.indexOf(": "); return [line.slice(0,colon), JSON.parse(line.slice(colon+2))];
    }));
    assert.ok(source.includes("prompt: |\n  {{ task | indent(2) }}"));
    assert.equal(recipe.parameters[0].input_type, "file");
    assert.equal(await fs.readFile(path.join(asset.localDir, "task.md"), "utf8"), prompt);
    assert.deepEqual(recipe.extensions.map(e => e.type), ["platform", "streamable_http"]);
    assert.equal(recipe.extensions[1].headers.Authorization, "Bearer test-token");
    assert.equal((await fs.stat(asset.recipeFile)).mode & 0o777, 0o600);
    if (process.env.GOOSE_TEST_BINARY) {
      const binary = process.env.GOOSE_TEST_BINARY;
      execFileSync(binary, ["recipe", "validate", asset.recipeFile], { stdio: "pipe" });
      const rendered = execFileSync(binary, ["run", "--recipe", asset.recipeFile, "--params", `task=${asset.localDir}/task.md`, "--render-recipe"], { encoding: "utf8" });
      assert.ok(rendered.includes('"quoted task"'));
      assert.ok(rendered.includes("{{ user_text }}"));
      assert.ok(rendered.includes("{% not_a_template %}"));
      assert.ok(rendered.includes("type: platform"));
    }
    const args = buildGooseRecipeArgs("/remote/recipe.yaml", 32);
    for (const forbidden of ["--no-profile", "--text", "--instructions", "-i", "-t"]) {
      assert.ok(!args.includes(forbidden));
      assert.throws(() => buildGooseRecipeArgs("recipe.yaml", 32, [forbidden]), /extraArgs/);
    }
  } finally { await fs.rm(asset.localDir, { recursive: true, force: true }); }
});

test("staged toolkit preserves company identity and resolves its dependencies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goose-test-"));
  const cid = "11111111-1111-4111-8111-111111111111";
  const resolver = 'import os, glob\nSKILLS_ROOT = "/paperclip/.claude/skills"\ndef resolve(slug):\n    mine = [p for p in glob.glob(SKILLS_ROOT + "/" + slug + "*") if os.environ["PAPERCLIP_COMPANY_ID"] in os.path.realpath(p)]\n    assert len(mine) == 1, "company guard"\n    return mine[0]\n';
  let asset;
  try {
    const names = ["mia3-lib", "analytics-core-lib", "mia3-catalog-motor", "unassigned"];
    const entries = [];
    for (const name of names) {
      const source = path.join(root, name);
      await fs.mkdir(path.join(source, "scripts"), { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), `# ${name}`);
      entries.push({ key: `company/${cid}/${name}`, runtimeName: `${name}--abc`, source });
    }
    await fs.writeFile(path.join(root, "mia3-lib/scripts/bootstrap.py"), resolver);
    await fs.writeFile(path.join(root, "mia3-lib/scripts/mia.py"), 'import bootstrap\nprint(bootstrap.resolve("analytics-core-lib"))\nprint(bootstrap.resolve("mia3-catalog-motor"))\n');
    const config = { paperclipRuntimeSkills: entries, paperclipSkillSync: { desiredSkills: entries.slice(0,3).map(e => e.key) } };
    asset = await createGooseSkillsAsset(config, cid);
    const staged = path.join(asset.localDir, asset.relativeDir);
    assert.equal((await fs.readdir(staged)).length, 3);
    const env = { ...process.env, PAPERCLIP_SKILLS_ROOT: staged, PAPERCLIP_COMPANY_ID: cid, PYTHONDONTWRITEBYTECODE: "1" };
    const output = execFileSync("python3", [path.join(staged, "mia3-lib--abc/scripts/mia.py")], { env, encoding: "utf8" });
    assert.match(output, /analytics-core-lib--abc/);
    assert.match(output, /mia3-catalog-motor--abc/);
    assert.equal(await fs.readFile(path.join(root, "mia3-lib/scripts/bootstrap.py"), "utf8"), resolver);
    assert.throws(() => execFileSync("python3", [path.join(staged, "mia3-lib--abc/scripts/mia.py")], {
      env: { ...env, PAPERCLIP_COMPANY_ID: "another-company" }, stdio: "pipe" }), /Command failed/);
    await assert.rejects(createGooseSkillsAsset(config, "another-company"), /Cross-company/);
  } finally {
    if (asset) await fs.rm(asset.localDir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Goose stream preserves spaces and excludes user/tool results", () => {
  const message = (role, text) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
  const stream = [message("assistant", "Выдано"), message("user", "INTERNAL TOOL RESULT"),
    message("assistant", " 333"), message("assistant", " бонуса.\n"), message("assistant", "Проверено.")].join("\n");
  assert.equal(parseGooseStreamJson(stream).summary, "Выдано 333 бонуса.\nПроверено.");
});
