import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { createServerAdapter } from "./server/index.js";

/**
 * This package intentionally overrides the unused built-in `grok_local` type.
 * The Paperclip core keeps its SSH capability metadata for that type, while
 * this external implementation launches Goose instead of Grok Build.
 */
export const type = "grok_local";
export const label = "Goose (grok_local override)";
export const DEFAULT_GOOSE_PROVIDER = "ai-gate";
export const DEFAULT_GOOSE_MODEL = "ai-gate/gpt-5.6-luna";

export const agentConfigurationDoc = `# Goose over SSH (grok_local override)

This external adapter overrides the unused built-in \`grok_local\` type and
runs Goose on the selected Paperclip SSH environment. The Paperclip core is
not modified.

## Model routing

- Set the Paperclip agent model to \`ai-gate/<model>\` to select the main Goose model.
- Set \`AI_GATE_BASE_URL\` and \`AI_GATE_MODELS\` in adapter environment
  variables to stage an OpenAI-compatible AI Gate provider catalog on the SSH
  worker.
- Set \`GOOSE_SUBAGENT_PROVIDER\` and \`GOOSE_SUBAGENT_MODEL\` to choose
  Goose's default subagent model independently from the main model.
- \`AI_GATE_API_KEY\` is passed only to the remote Goose process and is never
  included in the prompt.

## Remote prerequisites

The SSH worker must have the \`goose\` executable installed. The adapter does
not install Goose inside the Paperclip container or on the remote host.

The adapter requires an SSH execution environment. It stages the Paperclip
workspace to the worker, runs \`goose run --output-format stream-json\`, and
restores workspace changes after the run.
`;

export { createServerAdapter };
export type { ServerAdapterModule };
