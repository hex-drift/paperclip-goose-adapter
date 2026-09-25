import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createInstructionContext } from "../dist/server/instruction-context.js";

test("precomputed parallel pages match the generic reader byte-for-byte", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goose-bundle-test-"));
  let asset;
  try {
    const documents = [];
    for (const slug of ["mia3-identity", "mia3-conversation", "mia3-report", "mia3-analysis", "mia3-metrics", "mia3-catalog-motor"]) {
      const file = path.join(root, `${slug}.md`);
      await fs.writeFile(file, `# Scope\n${"правило🪿\n".repeat(800)}\n## New requirement\nKeep me.\n`);
      documents.push({ id: `${slug}--hash`, file });
    }
    asset = await createInstructionContext(documents);
    const manifestFile = path.join(asset.localDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    const bundle = manifest.bundles.bonus;
    assert.ok(bundle.pages.length > 1);
    const read = args => execFileSync("python3", [path.join(asset.localDir, "read-instructions.py"), "read", "--manifest", manifestFile, ...args], { encoding: "utf8", stdio: "pipe" });
    for (let i = 1; i <= bundle.pages.length; i++) {
      assert.ok(asset.instructions.includes(`--bundle bonus --page ${i} --expect ${bundle.sha256}`));
      const a = read(["--bundle", "bonus", "--page", String(i), "--expect", bundle.sha256]);
      const b = read(["--select", ...bundle.selectors, "--page", String(i), "--expect", bundle.sha256]);
      const body = output => output.slice(output.indexOf("\n", output.indexOf("\n") + 1) + 1, output.lastIndexOf("\nEND_PAGE"));
      assert.equal(body(a), body(b));
      assert.ok(Buffer.byteLength(a) < 48_000);
    }
    await fs.appendFile(path.join(asset.localDir, bundle.pages[0].file), "corruption");
    assert.throws(() => read(["--bundle", "bonus"]), /checksum changed/);
  } finally {
    if (asset) await fs.rm(asset.localDir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});
