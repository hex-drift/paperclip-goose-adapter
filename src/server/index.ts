import type {
  AdapterSessionCodec,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, type } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    if (!sessionId) return null;
    return {
      sessionId,
      ...(typeof record.cwd === "string" && record.cwd.trim() ? { cwd: record.cwd.trim() } : {}),
      ...(record.remoteExecution && typeof record.remoteExecution === "object"
        ? { remoteExecution: record.remoteExecution }
        : {}),
    };
  },
  serialize(params) {
    if (!params || typeof params.sessionId !== "string" || !params.sessionId.trim()) return null;
    return {
      sessionId: params.sessionId.trim(),
      ...(typeof params.cwd === "string" && params.cwd.trim() ? { cwd: params.cwd.trim() } : {}),
      ...(params.remoteExecution && typeof params.remoteExecution === "object"
        ? { remoteExecution: params.remoteExecution }
        : {}),
    };
  },
  getDisplayId(params) {
    return typeof params?.sessionId === "string" && params.sessionId.trim()
      ? params.sessionId.trim()
      : null;
  },
};

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    models: [],
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    getRuntimeCommandSpec: (config) => ({
      command: typeof config.command === "string" && config.command.trim() ? config.command.trim() : "goose",
      detectCommand: typeof config.command === "string" && config.command.trim() ? config.command.trim() : "goose",
      installCommand: null,
    }),
    agentConfigurationDoc,
  };
}
