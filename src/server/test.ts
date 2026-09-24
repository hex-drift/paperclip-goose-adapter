import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { asNumber, asString, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { resolveGooseRuntimeConfig } from "./config.js";

function status(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget });
  const config = parseObject(ctx.config);
  const command = asString(config.command, "goose") || "goose";
  const runtime = resolveGooseRuntimeConfig(config);

  if (!target || target.kind !== "remote" || target.transport !== "ssh") {
    checks.push({
      code: "goose_ssh_target_required",
      level: "error",
      message: "Goose override requires an SSH execution environment.",
      hint: "Select a Paperclip environment with driver SSH.",
    });
    return { adapterType: "grok_local", status: status(checks), checks, testedAt: new Date().toISOString() };
  }

  checks.push({
    code: "goose_environment_target",
    level: "info",
    message: `Testing Goose on ${ctx.environmentName ?? describeAdapterExecutionTarget(target)}.`,
  });
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), target.remoteCwd);
  const envConfig = parseObject(config.env);
  const env = Object.fromEntries(
    Object.entries({ ...envConfig, GOOSE_PROVIDER: runtime.provider, GOOSE_MODEL: runtime.model }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, ensurePathInEnv({ ...process.env, ...env }), {
      timeoutSec: Math.max(5, asNumber(config.timeoutSec, 30)),
    });
    checks.push({ code: "goose_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (error) {
    checks.push({
      code: "goose_command_unresolvable",
      level: "error",
      message: error instanceof Error ? error.message : "Goose command is not executable.",
      detail: command,
    });
  }

  if (checks.some((check) => check.level === "error")) {
    return { adapterType: "grok_local", status: status(checks), checks, testedAt: new Date().toISOString() };
  }

  const version = await runAdapterExecutionTargetProcess(
    `goose-envtest-${Date.now()}`,
    target,
    command,
    ["--version"],
    {
      cwd,
      env,
      timeoutSec: Math.max(5, Math.min(asNumber(config.helloProbeTimeoutSec, 30), 30)),
      graceSec: 5,
      onLog: async () => {},
    },
  );
  if (version.timedOut || (version.exitCode ?? 1) !== 0) {
    checks.push({
      code: "goose_version_probe_failed",
      level: "error",
      message: "Goose version probe failed.",
      detail: version.stderr.trim() || version.stdout.trim() || undefined,
    });
  } else {
    checks.push({
      code: "goose_version_probe_passed",
      level: "info",
      message: `Goose is available${version.stdout.trim() ? ` (${version.stdout.trim()})` : ""}.`,
    });
  }

  if (runtime.provider === "ai-gate" && !runtime.aiGateBaseUrl) {
    checks.push({
      code: "ai_gate_provider_catalog_not_staged",
      level: "warn",
      message: "AI Gate base URL is not configured for this agent.",
      hint: "Set AI_GATE_BASE_URL if the remote Goose host does not already have an ai-gate custom provider.",
    });
  }
  if (runtime.provider === "ai-gate" && !envConfig.AI_GATE_API_KEY) {
    checks.push({
      code: "ai_gate_key_not_in_agent_env",
      level: "info",
      message: "AI_GATE_API_KEY is not set in this agent environment; Goose will use remote credential storage if configured.",
    });
  }

  return { adapterType: "grok_local", status: status(checks), checks, testedAt: new Date().toISOString() };
}
