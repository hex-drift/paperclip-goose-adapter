import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createGooseRecipeAsset } from "../dist/server/config.js";

test("Goose 1.52 loads and calls the actual stdio MCP through a recipe", { skip: !process.env.GOOSE_TEST_BINARY, timeout: 30000 }, async () => {
  const asset = await createGooseRecipeAsset({ mcpServers: [], provider: "openai", model: "gpt-4o",
    maxTurns: 4, motorReportTool: true, prompt: "Exercise the report tool validation; do not query production." });
  let count = 0;
  let hasTool = false;
  let sawValidationError = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o", object: "model", created: 1, owned_by: "test" }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const tool = body.tools?.find(t => t.function?.name.includes("prepare_bonus_report"));
    hasTool ||= Boolean(tool);
    sawValidationError ||= JSON.stringify(body.messages).includes("invalid_date");
    count++;
    const delta = count === 1 && tool
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call-validation", type: "function",
          function: { name: tool.function.name, arguments: '{"date":"invalid"}' } }] }
      : { role: "assistant", content: "MCP_VALIDATED" };
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "test", object: "chat.completion", created: 1, model: "gpt-4o",
        choices: [{ index: 0, message: delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.env.GOOSE_TEST_BINARY, ["run", "--recipe", asset.recipeFile, "--no-session", "--output-format", "stream-json",
        "--params", `task=${asset.localDir}/task.md`], { cwd: asset.localDir, env: {
          ...process.env, GOOSE_PATH_ROOT: path.join(asset.localDir, "goose-home"),
          GOOSE_PROVIDER: "openai", GOOSE_MODEL: "gpt-4o", GOOSE_MODE: "auto",
          GOOSE_DISABLE_SESSION_NAMING: "true", OPENAI_API_KEY: "test-not-a-credential",
          OPENAI_HOST: `http://127.0.0.1:${addr.port}`, OPENAI_BASE_PATH: "v1/chat/completions",
        }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Goose smoke timeout: " + stderr)); }, 20000);
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(hasTool, "Goose never advertised the recipe MCP tool");
    assert.ok(sawValidationError, "MCP validation result did not reach the model");
    assert.ok(result.stdout.includes("MCP_VALIDATED"));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(asset.localDir, { recursive: true, force: true });
  }
});
