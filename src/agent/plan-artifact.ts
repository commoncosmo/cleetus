import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Persist an approved-plan candidate through trusted host code. The model still has no write or
 * shell capability in plan mode; this narrow path writes only beneath `.cleetus/plans`. */
export async function persistPlanArtifact(input: {
  projectDir: string;
  sessionId: string;
  plan: string;
  now?: number;
}): Promise<string> {
  const dir = join(input.projectDir, ".cleetus", "plans");
  await mkdir(dir, { recursive: true });
  const safeSession = input.sessionId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "session";
  const path = join(dir, `${safeSession}-${input.now ?? Date.now()}.md`);
  await writeFile(path, `${input.plan.trim()}\n`, { encoding: "utf8", flag: "wx" });
  return relative(input.projectDir, path);
}
