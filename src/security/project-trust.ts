import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CleetusError } from "../lib/errors";
import { realpathWithMissingParents } from "../permission/path-guard";
import { privateDirectory, writePrivateFile } from "./private-state";

const FILES = ["config.yaml", "permissions.yaml"] as const;
type ConfigFile = (typeof FILES)[number];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export interface ProjectTrustOptions {
  projectDir: string;
  globalPath: string;
  /** Optional embedding/test override; must still live outside the project. */
  trustStoreDir?: string;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function recordPath(opts: ProjectTrustOptions): Promise<string> {
  const root = await realpath(opts.projectDir);
  const store = await realpathWithMissingParents(
    resolve(opts.trustStoreDir ?? join(dirname(opts.globalPath), "project-trust")),
  );
  const rel = relative(root, store);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
    throw new Error(
      "Project trust records must be stored outside the project; use an external --config-dir.",
    );
  }
  return join(store, `${hash(root)}.json`);
}

export async function projectConfigurationSnapshot(
  opts: ProjectTrustOptions,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of FILES) {
    const text = await readOptional(join(opts.projectDir, ".cleetus", file));
    if (text !== null) hashes[file] = hash(text);
  }
  return hashes;
}

/** Call only from an explicit user approval surface, never during automatic loading. */
export async function approveProjectConfiguration(
  opts: ProjectTrustOptions,
  expected?: Record<string, string>,
): Promise<void> {
  const record = await recordPath(opts);
  privateDirectory(dirname(record));
  const snapshot = await projectConfigurationSnapshot(opts);
  if (expected && JSON.stringify(expected) !== JSON.stringify(snapshot)) {
    throw new Error("Project configuration changed during approval; review it again.");
  }
  writePrivateFile(record, JSON.stringify(snapshot));
}

/** Return the exact bytes whose digest was approved, avoiding a check-then-reread window. */
export async function readTrustedProjectFile(
  opts: ProjectTrustOptions,
  file: ConfigFile,
): Promise<string | null> {
  const text = await readOptional(join(opts.projectDir, ".cleetus", file));
  if (text === null) return null;
  let approved: Record<string, unknown> = {};
  try {
    approved = JSON.parse((await readOptional(await recordPath(opts))) ?? "{}");
  } catch {
    /* Missing, invalid or unsafe trust records never grant authority. */
  }
  if (approved?.[file] !== hash(text)) {
    throw new CleetusError(
      "CONFIG_INVALID",
      `Untrusted project configuration: .cleetus/${file}. Review it, then run 'cleetus trust --yes' with the same --config-dir. Changed configuration requires approval again.`,
    );
  }
  return text;
}
