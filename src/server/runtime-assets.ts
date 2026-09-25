import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Copy only this run's assigned skills; preserve company identity in real paths. */
export async function createGooseSkillsAsset(config: Record<string, unknown>, companyId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) throw new Error("Invalid skills company ID");
  const entries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desired = new Set(resolveLegacyPaperclipDesiredSkillNames(config, entries));
  const selected = entries.filter((entry) => desired.has(entry.key));
  if (!selected.length) return null;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-goose-skills-"));
  const relativeDir = `${companyId}/skills`;
  try {
    const skillsDir = path.join(root, relativeDir);
    await fs.mkdir(skillsDir, { recursive: true });
    for (const entry of selected) {
      if (isPaperclipSkillSourceMissing(entry)) throw new Error(`Assigned skill unavailable: ${entry.key}`);
      if (entry.key.startsWith("company/") && !entry.key.startsWith(`company/${companyId}/`)) {
        throw new Error("Cross-company skill assignment refused");
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(entry.runtimeName)) throw new Error("Invalid skill runtime name");
      const destination = path.join(skillsDir, entry.runtimeName);
      await fs.cp(entry.source, destination, { recursive: true, dereference: true });
      // Legacy MIA helpers have a host-only default. Rebase the staged copy,
      // retaining their company filter, ambiguity checks and query guards.
      if (["mia3-lib", "analytics-core-lib"].includes(entry.key.split("/").at(-1)!)) {
        for (const name of ["bootstrap.py", "skillpath.py"]) {
          const file = path.join(destination, "scripts", name);
          let content: string;
          try { content = await fs.readFile(file, "utf8"); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          const rebased = content.replace(
            'SKILLS_ROOT = "/paperclip/.claude/skills"',
            'SKILLS_ROOT = os.environ.get("PAPERCLIP_SKILLS_ROOT", "/paperclip/.claude/skills")',
          );
          if (rebased !== content) await fs.writeFile(file, rebased, "utf8");
        }
      }
    }
    return { localDir: root, relativeDir, entries: selected };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Recipe extensions replace defaults in Goose 1.52; --no-profile would erase them. */
export function buildGooseRecipeArgs(recipePath: string, maxTurns: number | null, extraArgs: string[] = []) {
  const reserved = ["--recipe", "--no-profile", "--instructions", "-i", "--text", "-t"];
  if (extraArgs.some((arg) => reserved.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
    throw new Error("extraArgs cannot override the Goose recipe input or disable its extensions");
  }
  return ["run", "--output-format", "stream-json", "--recipe", recipePath, "--no-session",
    ...(maxTurns ? ["--max-turns", String(maxTurns)] : []), ...extraArgs];
}
