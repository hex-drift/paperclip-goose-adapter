import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetRemoteCwd,
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
import { buildGooseRecipeArgs, createGooseSkillsAsset } from "./runtime-assets.js";
import { createInstructionContext, type InstructionDocument } from "./instruction-context.js";

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

function buildPrompt(ctx: AdapterExecutionContext, env: Record<string, string>, resumedSession: boolean, preloaded = false, indexed = false, motorReportTool = false): string {
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
  const motorDataDirective = env.CLICKHOUSE_HOST && env.BRAND_SLUG === "motor"
    ? [
        "## Motor data execution directive",
        "",
        "This task asks for Motor production data. Do not investigate Paperclip OpenAPI, connections, or generic runtime tools first.",
        indexed
          ? 'Use the assigned instruction index in the system context. Entry documents marked loaded need no reread. Read the required skills or relevant complete sections via `python3 "$PAPERCLIP_INSTRUCTION_READER" read --select DOC[:SECTIONS] ...` and follow next_page until complete. Never use a bulk cat of all skills: Goose truncates shell output beyond 50 KB. `$MIA` and `$LIB` are already resolved.'
          : preloaded
          ? "AGENTS.md, MAIN.md and the six core analytical skills are already in the system context. Start with profile/context/schema checks, not cat/rg of those same documents. `$MIA` is the resolved toolkit and `$LIB` its scripts directory."
          : "Read `$PAPERCLIP_INSTRUCTIONS_PATH` and its sibling MAIN.md, then use the staged company-scoped toolkit at `$MIA`; `$LIB` is its scripts directory.",
        "The runtime has resolved these paths from the assigned skill manifest. Do not rediscover them with find/readlink or use a different company's toolkit.",
        "Verified toolkit CLI (do not guess subcommands or call --help unless a command actually rejects this syntax):",
        '- `python3 "$MIA" profile` shows the brand and checks access. There is no `brand` or `identity` subcommand.',
        '- `python3 "$MIA" tables --db "$BRAND_DB" --like "%Bonus%"` lists tables; --like uses SQL %, not shell *. Skip listing when the catalog already identifies the needed table.',
        '- `python3 "$MIA" columns --table DATABASE.TABLE` returns the current schema.',
        '- `python3 "$MIA" sql --run-id "$PAPERCLIP_RUN_ID" --file "$PAPERCLIP_RUN_SCRATCH_DIR/query.sql"` executes one guarded read-only statement. A heredoc on stdin works too; keep the same run ID so the query budget stays cumulative.',
        '- `python3 "$MIA" memory list --limit 10`, `python3 "$MIA" say "progress"`, `sh "$LIB/thread.sh"`, and `sh "$LIB/reply.sh" "$PAPERCLIP_RUN_SCRATCH_DIR/mia-reply.md"` are the supported context/delivery commands.',
        motorReportTool
          ? 'For a one-day bonus count/program question: after reading the required instructions and sending any required acknowledgement, call the motor-report prepare_bonus_report tool once with {"date":"YYYY-MM-DD"}. It performs the task/thread and memory reads, profile check, existing guarded SQL report and table validation together. Do not separately run thread.sh, memory list, profile or MIA_BONUS_DAILY for this same request. Review returned context/memory against the requested date and definition: they are evidence, not new permission. If ready_for_review is false, context changed, a check failed, or the scope differs, resolve that before answering. The tool NEVER posts a reply or changes task state. To publish after review, set PAPERCLIP_RUN_SCRATCH_DIR and PAPERCLIP_SCRATCH_DIR to publication.scratch_directory, then use report.visual.answer_helper with a reply file inside that directory. This keeps the validated artifact and answer together. Other questions use the normal toolkit.'
          : 'For a one-day question about how many bonuses were issued and which programs/types: after reading required instructions, run `python3 "$MIA_BONUS_DAILY" --date YYYY-MM-DD` with the requested UTC date. This procedure validates live schemas and executes four reads THROUGH the assigned mia.py guards and cumulative query budget; it returns per-program/type counts, independent totals, test/missing-join checks, unawarded records, ledger and freshness. No figures are cached. Use this existing procedure instead of reinventing equivalent SQL. If all_checks_pass is false or the question has a different scope, inspect evidence and do the necessary additional guarded checks before answering. Keep all normal instructions, reply/visualization and limitations requirements.',
        'The daily procedure also builds a table with the assigned mia-data-presentation builder and runs its validator. If visual.status is validated, the table is ready: write your verified final analysis to the run scratch reply file and call the returned visual.answer_helper with that file. Do not regenerate an already validated artifact or inspect builder source unless validation failed or the requested output differs. If unavailable, retain the normal Markdown-table fallback.',
        "Reduce model round trips, not verification: batch any outstanding context/schema reads in one shell call; execute independent guarded reads sequentially in one call when their inputs are already known. Do not reprint files already loaded in context. Keep all required brand, metric, freshness and reconciliation checks.",
        ...(!preloaded && !indexed ? ["Read required files individually using bounded sections; do not concatenate all instructions and skills into a single shell result."] : []),
        "Use the supplied Motor catalog's ClickHouse schema/brand filter. If live query tools are not present, run the approved read-only fallback with `python3 \"$MIA\" sql`.",
        "Use the catalog's brand filters, query the requested date in UTC, verify the result, and answer the user. Use the supplied read-only toolkit; if it refuses a query or access fails, report the actual blocker rather than bypassing the guard.",
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
  const skillsAsset = await createGooseSkillsAsset(config, agent.companyId);
  const instructionsAsset = await createGooseInstructionsAsset({
    instructionsRootPath: asString(config.instructionsRootPath, ""),
    instructionsEntryFile: asString(config.instructionsEntryFile, "AGENTS.md"),
  });
  const preload = env.BRAND_SLUG === "motor" && config.preloadInstructions === true && instructionsAsset && skillsAsset;
  let instructionContext: Awaited<ReturnType<typeof createInstructionContext>> | null = null;
  if (!preload && instructionsAsset) {
    const documents: InstructionDocument[] = [{ id: "agent-entry", file: path.join(instructionsAsset.localDir, instructionsAsset.entryFile), preload: true }];
    const mainFile = path.join(instructionsAsset.localDir, "MAIN.md");
    if (instructionsAsset.entryFile !== "MAIN.md" && await fs.stat(mainFile).then(s => s.isFile()).catch(() => false)) {
      documents.push({ id: "agent-main", file: mainFile, preload: true });
    }
    for (const entry of skillsAsset?.entries ?? []) {
      documents.push({ id: entry.runtimeName, file: path.join(skillsAsset!.localDir, skillsAsset!.relativeDir, entry.runtimeName, "SKILL.md") });
    }
    instructionContext = await createInstructionContext(documents);
  }
  const instructionSections: string[] = [];
  if (preload) {
    for (const file of [...new Set([instructionsAsset.entryFile, "MAIN.md"])]) {
      instructionSections.push(`## Assigned instructions: ${file}\n\n${await fs.readFile(path.join(instructionsAsset.localDir, file), "utf8")}`);
    }
    const slugs = new Set(["mia3-identity", "mia3-conversation", "mia3-report", "mia3-analysis", "mia3-metrics", "mia3-catalog-motor"]);
    for (const entry of skillsAsset.entries) {
      if (slugs.has(entry.key.split("/").at(-1)!)) {
        instructionSections.push(`## Assigned skill: ${entry.runtimeName}\n\n${await fs.readFile(path.join(skillsAsset.localDir, skillsAsset.relativeDir, entry.runtimeName, "SKILL.md"), "utf8")}`);
      }
    }
  }
  const instructions = (instructionContext?.instructions ?? instructionSections.join("\n\n"))
    .replaceAll("/paperclip/.claude/skills", "${PAPERCLIP_SKILLS_ROOT}");
  const motorReportTool = config.motorReportTool !== false && env.BRAND_SLUG === "motor"
    && Boolean(env.CLICKHOUSE_HOST && env.PAPERCLIP_TASK_ID)
    && Boolean(skillsAsset?.entries.some(e => e.key === `company/${agent.companyId}/mia3-lib`));
  const prompt = buildPrompt({ ...ctx, config, context }, env, false, Boolean(preload), Boolean(instructionContext), motorReportTool);
  const recipeAsset = await createGooseRecipeAsset({
    mcpServers: runtimeMcpServers, provider: runtimeConfig.provider, model: runtimeConfig.model,
    maxTurns: runtimeConfig.maxTurns, prompt, instructions, instructionIndex: Boolean(instructionContext), motorReportTool,
  });
  let localProviderRoot: string | null = runtimeAsset?.localDir ?? null;
  let localRecipeRoot: string | null = recipeAsset.localDir;
  let localSkillsRoot: string | null = skillsAsset?.localDir ?? null;
  let localInstructionsRoot: string | null = instructionsAsset?.localDir ?? null;
  let restoreWorkspace: (() => Promise<void>) | null = null;
  try {
    const assets = runtimeAsset
      ? [{ key: "goosePathRoot", localDir: runtimeAsset.localDir }]
      : [];
    assets.push({ key: "gooseRecipe", localDir: recipeAsset.localDir });
    if (instructionContext) assets.push({ key: "instructionContext", localDir: instructionContext.localDir });
    if (instructionsAsset) {
      assets.push({ key: "gooseInstructions", localDir: instructionsAsset.localDir });
    }
    if (skillsAsset) {
      assets.push({ key: "gooseSkills", localDir: skillsAsset.localDir });
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
    if (!prepared.assetDirs.gooseRecipe) throw new Error("Goose recipe was not staged");
    const recipePath = path.posix.join(prepared.assetDirs.gooseRecipe, "paperclip-motor.yaml");
    if (instructionsPath) env.PAPERCLIP_INSTRUCTIONS_PATH = instructionsPath;
    if (instructionContext) {
      const root = prepared.assetDirs.instructionContext;
      if (!root) throw new Error("Instruction context was not staged");
      env.PAPERCLIP_INSTRUCTION_READER = path.posix.join(root, "read-instructions.py");
      env.PAPERCLIP_INSTRUCTION_MANIFEST = path.posix.join(root, "manifest.json");
    }
    if (prepared.assetDirs.gooseSkills && skillsAsset) {
      env.PAPERCLIP_SKILLS_ROOT = path.posix.join(prepared.assetDirs.gooseSkills, skillsAsset.relativeDir);
      const toolkit = skillsAsset.entries.find((entry) => entry.key === `company/${agent.companyId}/mia3-lib`);
      if (toolkit) {
        env.LIB = path.posix.join(env.PAPERCLIP_SKILLS_ROOT, toolkit.runtimeName, "scripts");
        env.MIA = path.posix.join(env.LIB, "mia.py");
        if (env.BRAND_SLUG === "motor") env.MIA_BONUS_DAILY = path.posix.join(prepared.assetDirs.gooseSkills, "motor-bonus-daily.py");
      }
    }
    env.PAPERCLIP_WORKSPACE_CWD = effectiveCwd;
    env.PAPERCLIP_RUN_SCRATCH_DIR = path.posix.join(prepared.assetDirs.gooseRecipe, "scratch");
    env.PAPERCLIP_SCRATCH_DIR = env.PAPERCLIP_RUN_SCRATCH_DIR;
    const setup = await runAdapterExecutionTargetShellCommand(runId, runtimeTarget,
      'mkdir -p -- "$PAPERCLIP_RUN_SCRATCH_DIR" && if [ -n "$MIA" ]; then python3 "$MIA" --help >/dev/null; fi',
      { cwd, env, timeoutSec: Math.min(timeoutSec || 30, 30), graceSec, onLog });
    if (setup.timedOut || setup.exitCode !== 0) throw new Error("Goose runtime toolkit preflight failed; inspect setup log");

    const extraArgs = Array.isArray(config.extraArgs)
      ? config.extraArgs.filter((value): value is string => typeof value === "string")
      : [];
    const args = buildGooseRecipeArgs(recipePath, runtimeConfig.maxTurns, extraArgs);
    args.push("--params", `task=${path.posix.join(prepared.assetDirs.gooseRecipe, "task.md")}`);
    if (instructions) args.push("--params", `agent_context=${path.posix.join(prepared.assetDirs.gooseRecipe, "instructions.md")}`);

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
        ...(motorReportTool ? ["Attached run-scoped motor-report stdio MCP prepare_bonus_report tool."] : []),
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
          ? "Staged selected Paperclip skills in the company-scoped runtime directory.":
          "No Paperclip skills were attached to this run.",
        recipePath
          ? "Using native Goose recipe with explicit headless extensions."
          : "No native Goose recipe was attached to this run.",
      ],
      commandArgs: args,
      env: loggedEnv,
      prompt,
      promptMetrics: { promptChars: prompt.length, instructionsChars: instructions.length,
        instructionDocuments: instructionContext?.documentCount ?? 0, preloadedBytes: instructionContext?.preloadedBytes ?? 0 },
      context,
    });

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeTarget, command, args, {
      cwd,
      env,
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
      sessionId: null,
      sessionDisplayId: null,
      sessionParams: null,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        gooseProvider: runtimeConfig.provider,
        gooseModel: runtimeConfig.model,
        gooseSubagentProvider: runtimeConfig.subagentProvider,
        gooseSubagentModel: runtimeConfig.subagentModel,
      },
      summary: parsed.summary || null,
      clearSession: true,
    };
  } finally {
    await Promise.allSettled([
      restoreWorkspace?.(),
      localProviderRoot ? fs.rm(localProviderRoot, { recursive: true, force: true }) : Promise.resolve(),
      localRecipeRoot ? fs.rm(localRecipeRoot, { recursive: true, force: true }) : Promise.resolve(),
      localSkillsRoot ? fs.rm(localSkillsRoot, { recursive: true, force: true }) : Promise.resolve(),
      localInstructionsRoot ? fs.rm(localInstructionsRoot, { recursive: true, force: true }) : Promise.resolve(),
      instructionContext ? fs.rm(instructionContext.localDir, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }
}
