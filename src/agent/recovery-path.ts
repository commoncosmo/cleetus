import { basename, join } from "node:path";

function safeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

/** Stable, project-specific storage outside the model-writable work tree. */
export function projectRecoveryDir(configRoot: string, projectDir: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(projectDir).digest("hex").slice(0, 16);
  return join(configRoot, "recovery", `${safeSlug(basename(projectDir))}-${hash}`);
}

export function projectAuditDbPath(configRoot: string, projectDir: string): string {
  return join(projectRecoveryDir(configRoot, projectDir), "events.db");
}

export function projectCheckpointMirrorDir(configRoot: string, projectDir: string): string {
  return join(projectRecoveryDir(configRoot, projectDir), "checkpoints.git");
}
