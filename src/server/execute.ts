import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetShellCommand,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  renderTemplate,
  refreshPaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_GOOSE_MODEL } from "../index.js";
import {
  applyGooseEnvironment,
  createGooseRecipeAsset,
  createGooseRuntimeAsset,
  createGooseInstructionsAsset,
  mergeGooseRuntimeMcpServers,
  resolveGooseRuntimeConfig,
} from "./config.js";
import { parseGooseStreamJson } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function requireSshTarget(ctx: AdapterExecutionContext) {
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (!target || target.kind !== "remote" || target.transport !== "ssh") {
    throw new Error("The Goose grok_local override requires a Paperclip SSH execution environment.");
  }
  return target;
}

function addContextEnvironment(
  env: Record<string, string>,
  context: Record<string, unknown>,
): void {
  const taskId = typeof context.taskId === "string" && context.taskId.trim()
    ? context.taskId.trim()
    : typeof context.issueId === "string" && context.issueId.trim()
      ? context.issueId.trim()
      : "";
  const wakeReason = typeof context.wakeReason === "string" ? context.wakeReason.trim() : "";
  const commentId = typeof context.commentId === "string" && context.commentId.trim()
    ? context.commentId.trim()
    : typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()
      ? context.wakeCommentId.trim()
      : "";
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (commentId) env.PAPERCLIP_WAKE_COMMENT_ID = commentId;
  const approvalId = typeof context.approvalId === "string" ? context.approvalId.trim() : "";
  const approvalStatus = typeof context.approvalStatus === "string" ? context.approvalStatus.trim() : "";
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  const wakePayload = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayload) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayload;
}

function buildPrompt(ctx: AdapterExecutionContext, env: Record<string, string>, resumedSession: boolean): string {
  const config = ctx.config;
  const context = ctx.context;
  const template = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const data = {
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    agent: ctx.agent,
    run: { id: ctx.runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession });
  const handoff = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const motorDataDirective = env.CLICKHOUSE_HOST
    ? [
        "## Motor data execution directive",
        "",
        "This task asks for Motor production data. Do not investigate Paperclip OpenAPI, connections, or generic runtime tools first.",
        "Immediately use the staged company-scoped MIA toolkit; its root is in `$PAPERCLIP_SKILLS_ROOT`.",
        "Resolve it with `MIA=$(readlink -f \"$PAPERCLIP_SKILLS_ROOT\"/mia3-lib*/scripts/mia.py | grep \"$PAPERCLIP_COMPANY_ID\")`.",
        "Read the staged Motor catalog skill from `$PAPERCLIP_SKILLS_ROOT/mia3-catalog-motor-*` and use its ClickHouse schema/brand filter. If live query tools are not present, run the approved read-only fallback with `python3 \"$MIA\" sql`.",
        "Use the Motor brand filter (PartnerId = 100 on chr_NextCode2/ai_analytics), query the requested date in UTC, verify the result, and answer the user. Do not stop at saying that data access is unavailable while CLICKHOUSE_HOST and CLICKHOUSE_PASSWORD are present.",
        "",
      ].join("\n")
    : "";
  return joinPromptSections([
    motorDataDirective,
    wakePrompt,
    handoff,
    renderTemplate(template, data),
    Object.keys(env).some((key) => key.startsWith("PAPERCLIP_"))
      ? `Paperclip runtime variables are available in the environment: ${Object.keys(env).filter((key) => key.startsWith("PAPERCLIP_")).sort().join(", ")}.`
      : "",
  ]);
}

async function createGooseSkillsAsset(config: Record<string, unknown>): Promise<string | null> {
  const entries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desired = new Set(resolveLegacyPaperclipDesiredSkillNames(config, entries));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-goose-skills-"));
  const skillsDir = path.join(root, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  let copied = 0;
  for (const entry of entries) {
    if (!desired.has(entry.key) || isPaperclipSkillSourceMissing(entry)) continue;
    await fs.cp(entry.source, path.join(skillsDir, entry.runtimeName), {
      recursive: true,
      dereference: true,
    });
    copied += 1;
  }
  if (copied === 0) {
    await fs.rm(root, { recursive: true, force: true });
    return null;
  }
  return root;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const target = requireSshTarget(ctx);
  const { agent, config, context, onLog, onMeta, onSpawn, authToken, runId } = ctx;
  const runtimeConfig = resolveGooseRuntimeConfig({
    ...config,
    model: asString(config.model, DEFAULT_GOOSE_MODEL) || DEFAULT_GOOSE_MODEL,
  });
  const command = asString(config.command, "goose") || "goose";
  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceSource = asString(workspace.source, "");
  const workspaceId = asString(workspace.workspaceId, "");
  const workspaceRepoUrl = asString(workspace.repoUrl, "");
  const workspaceRepoRef = asString(workspace.repoRef, "");
  const agentHome = asString(workspace.agentHome, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = asString(workspace.cwd, "") || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  let env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  addContextEnvironment(env, context);
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: asString(workspace.cwd, ""),
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints: Array.isArray(context.paperclipWorkspaces) ? context.paperclipWorkspaces : [],
    agentHome,
    executionTargetIsRemote: true,
    executionCwd: adapterExecutionTargetRemoteCwd(target, cwd),
  });
  env = applyGooseEnvironment(env, runtimeConfig);

  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(target, asNumber(config.timeoutSec, 0));
  const graceSec = asNumber(config.graceSec, 20);
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv, { timeoutSec });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, target, cwd, runtimeEnv);

  const runtimeMcpServers = mergeGooseRuntimeMcpServers(
    env,
    ctx.runtimeMcp?.getServers() ?? [],
  );
  const runtimeAsset = await createGooseRuntimeAsset({ mcpServers: runtimeMcpServers });
  const recipeAsset = await createGooseRecipeAsset({
    mcpServers: runtimeMcpServers,
    provider: runtimeConfig.provider,
    model: runtimeConfig.model,
    maxTurns: runtimeConfig.maxTurns,
    prompt: buildPrompt({ ...ctx, config, context }, env, false),
  });
  const skillsAsset = await createGooseSkillsAsset(config);
  const instructionsAsset = await createGooseInstructionsAsset({
    instructionsRootPath: asString(config.instructionsRootPath, ""),
    instructionsEntryFile: asString(config.instructionsEntryFile, "AGENTS.md"),
  });
  let localProviderRoot: string | null = runtimeAsset?.localDir ?? null;
  let localRecipeRoot: string | null = recipeAsset.localDir;
  let localSkillsRoot: string | null = skillsAsset;
  let localInstructionsRoot: string | null = instructionsAsset?.localDir ?? null;
  let restoreWorkspace: (() => Promise<void>) | null = null;
  try {
    const assets = runtimeAsset
      ? [{ key: "goosePathRoot", localDir: runtimeAsset.localDir }]
      : [];
    assets.push({ key: "gooseRecipe", localDir: recipeAsset.localDir });
    if (instructionsAsset) {
      assets.push({ key: "gooseInstructions", localDir: instructionsAsset.localDir });
    }
    if (skillsAsset) {
      assets.push({ key: "gooseSkills", localDir: skillsAsset });
    }
    await onLog(
      "stdout",
      `[paperclip] Staging workspace for Goose on ${describeAdapterExecutionTarget(target)}.\n`,
    );
    const prepared = await prepareAdapterExecutionTargetRuntime({
      runId,
      target,
      adapterKey: "goose",
      timeoutSec,
      workspaceLocalDir: cwd,
      detectCommand: command,
      installCommand: null,
      onProgress: (line) => onLog("stdout", line),
      onRuntimeProgress: ctx.onRuntimeProgress,
      assets,
    });
    restoreWorkspace = () => prepared.restoreWorkspace((line) => onLog("stdout", line));
    const effectiveCwd = prepared.workspaceRemoteDir ?? target.remoteCwd;
    const runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target, effectiveCwd) ?? target;
    if (prepared.assetDirs.goosePathRoot) env.GOOSE_PATH_ROOT = prepared.assetDirs.goosePathRoot;
    const instructionsPath = prepared.assetDirs.gooseInstructions
      ? path.posix.join(prepared.assetDirs.gooseInstructions, instructionsAsset!.entryFile)
      : null;
    const recipePath = prepared.assetDirs.gooseRecipe
      ? path.posix.join(prepared.assetDirs.gooseRecipe, "paperclip-motor.yaml")
      : null;
    if (prepared.assetDirs.gooseSkills) {
      const remoteHome = asString(env.HOME, "/paperclip");
      const remoteSkills = path.posix.join(remoteHome, ".claude", "skills");
      await runAdapterExecutionTargetShellCommand(
        runId,
        runtimeTarget,
        `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSkills))} && rm -rf ${JSON.stringify(remoteSkills)} && cp -a ${JSON.stringify(prepared.assetDirs.gooseSkills)} ${JSON.stringify(remoteSkills)}`,
        {
          cwd,
          env,
          timeoutSec,
          graceSec,
          onLog,
        },
      );
    }
    if (prepared.assetDirs.gooseSkills) {
      env.PAPERCLIP_SKILLS_ROOT = path.posix.join(prepared.assetDirs.gooseSkills, "skills");
    }

    const runtimeSessionParams = parseObject(ctx.runtime.sessionParams);
    const savedSession = typeof runtimeSessionParams.sessionId === "string" ? runtimeSessionParams.sessionId.trim() : "";
    const persistSession = runtimeConfig.persistSession && !runtimeAsset;
    const sessionId = persistSession ? savedSession || `paperclip-${agent.id}` : "";
    const prompt = joinPromptSections([
      instructionsPath
        ? "The Paperclip instructions bundle and selected skills are staged in the runtime. Use the exact staged paths from PAPERCLIP_SKILLS_ROOT; do not search the filesystem or Paperclip API for them."
        : "",
      buildPrompt({ ...ctx, config, context }, env, Boolean(sessionId)),
    ]);
    const args = ["run", "--output-format", "stream-json", "--no-profile"];
    if (recipePath) args.push("--recipe", recipePath);
    if (!persistSession) args.push("--no-session");
    if (sessionId) args.push("--name", sessionId, "--resume");
    if (runtimeConfig.maxTurns) args.push("--max-turns", String(runtimeConfig.maxTurns));
    const extraArgs = Array.isArray(config.extraArgs)
      ? config.extraArgs.filter((value): value is string => typeof value === "string")
      : [];
    args.push(...extraArgs);
    if (!recipePath) args.push("-i", "-");

    const loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv: ensurePathInEnv({ ...process.env, ...env }),
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    await onMeta?.({
      adapterType: "grok_local",
      command: resolvedCommand,
      cwd: effectiveCwd,
      commandNotes: [
        "External grok_local override: runs Goose over SSH.",
        `Goose main model: ${runtimeConfig.provider}/${runtimeConfig.model}`,
        runtimeConfig.subagentModel
          ? `Goose subagent model: ${runtimeConfig.subagentProvider ?? runtimeConfig.provider}/${runtimeConfig.subagentModel}`
          : "Goose subagent model comes from the remote Goose configuration.",
        runtimeConfig.provider === "ai-gate"
          ? "Mapped AI Gate to Goose's built-in OpenAI-compatible provider."
          : "Using the configured Goose provider.",
        runtimeAsset
          ? `Injected ${runtimeAsset.mcpCount} Paperclip/runtime MCP server(s) into Goose streamable HTTP extensions.`
          : "No Paperclip runtime MCP servers were attached to this run.",
        instructionsPath
          ? `Injected Paperclip instructions bundle into Goose: ${instructionsAsset!.entryFile}.`
          : "No Paperclip instructions bundle was attached to this run.",
        prepared.assetDirs.gooseSkills
          ? "Injected selected Paperclip skills into the remote Goose home.":
          "No Paperclip skills were attached to this run.",
        recipePath
          ? "Using native Goose recipe with explicit headless extensions."
          : "No native Goose recipe was attached to this run.",
      ],
      commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
      env: loggedEnv,
      prompt,
      promptMetrics: { promptChars: prompt.length },
      context,
    });

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onLog,
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
    });
    const parsed = parseGooseStreamJson(proc.stdout);
    const errorMessage = parsed.errorMessage || firstNonEmptyLine(proc.stderr) || null;
    const failed = proc.timedOut || (proc.exitCode ?? 0) !== 0 || Boolean(parsed.errorMessage);
    return {
      exitCode: failed && (proc.exitCode ?? 0) === 0 ? 1 : proc.exitCode,
      signal: proc.signal,
      timedOut: proc.timedOut,
      errorMessage: proc.timedOut ? `Timed out after ${timeoutSec}s` : failed ? errorMessage || "Goose run failed" : null,
      usage: {
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cachedInputTokens: parsed.cachedInputTokens,
      },
      usageBasis: "per_run",
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      billingType: "unknown",
      costUsd: parsed.costUsd,
      sessionId: sessionId || parsed.sessionId,
      sessionDisplayId: sessionId || parsed.sessionId,
      sessionParams: sessionId || parsed.sessionId
        ? {
            sessionId: sessionId || parsed.sessionId,
            cwd: effectiveCwd,
            remoteExecution: adapterExecutionTargetSessionIdentity(runtimeTarget),
          }
        : null,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        gooseProvider: runtimeConfig.provider,
        gooseModel: runtimeConfig.model,
        gooseSubagentProvider: runtimeConfig.subagentProvider,
        gooseSubagentModel: runtimeConfig.subagentModel,
      },
      summary: parsed.summary || null,
      clearSession: Boolean(sessionId && failed),
    };
  } finally {
    await Promise.allSettled([
      restoreWorkspace?.(),
      localProviderRoot ? fs.rm(localProviderRoot, { recursive: true, force: true }) : Promise.resolve(),
      localRecipeRoot ? fs.rm(localRecipeRoot, { recursive: true, force: true }) : Promise.resolve(),
      localSkillsRoot ? fs.rm(localSkillsRoot, { recursive: true, force: true }) : Promise.resolve(),
      localInstructionsRoot ? fs.rm(localInstructionsRoot, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }
}
