import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { userPaths } from "../config/user-paths";
import { shellQuote } from "../git/quote";
import { CleetusError } from "../lib/errors";
import { isPathWithin } from "../lib/paths";
import { realpathWithMissingParents } from "../permission/path-guard";
import { privateDirectory, writePrivateFile } from "./private-state";

const FILES = ["config.yaml", "permissions.yaml"] as const;
type ConfigFile = (typeof FILES)[number];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// Deliberately allowlist tuning/presentation fields. New top-level fields require review.
// Bump the policy key if an allowlisted section ever gains authority-bearing settings.
const TUNING_FIELDS = new Set([
  "ui",
  "streaming",
  "default_effort",
  "default_personality",
  "personality_correction",
  "max_tool_loops",
  "structured_output",
  "capability",
  "model_profiles",
  "model_family",
  "context",
  "loop_guard",
  "stream_watchdog",
  "resize",
  "malformed_path",
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

function authorityDigest(text: string, file: ConfigFile): string {
  // Compare YAML values before env interpolation; never persist credentials or config contents.
  const raw: unknown = parseYaml(text) ?? {};
  const authority =
    file === "config.yaml" && raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => !TUNING_FIELDS.has(key)))
      : raw;
  return hash(JSON.stringify(canonical(authority)));
}

interface TrustRecord {
  [key: string]: unknown;
  authorityV1?: Record<string, string>;
}

async function readRecord(path: string): Promise<TrustRecord> {
  try {
    const value = JSON.parse((await readOptional(path)) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function projectTrustCommand(opts: ProjectTrustOptions): string {
  const quote =
    process.platform === "win32"
      ? (value: string) => `'${value.replaceAll("'", "''")}'`
      : shellQuote;
  if (opts.trustGlobalWorkspace) {
    const configDir = resolve(dirname(opts.globalPath));
    const configFlag =
      configDir === userPaths().configRoot ? "" : ` --config-dir ${quote(configDir)}`;
    return `cleetus trust --global${configFlag} --yes`;
  }
  return `cleetus trust --directory ${quote(resolve(opts.projectDir))} --config-dir ${quote(resolve(dirname(opts.globalPath)))} --yes`;
}

export interface ProjectTrustOptions {
  projectDir: string;
  globalPath: string;
  /** Optional embedding/test override; must still live outside the project. */
  trustStoreDir?: string;
  /** Use the global-workspace recovery command; does not change trust enforcement. */
  trustGlobalWorkspace?: boolean;
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
  if (isPathWithin(root, store)) {
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
  const snapshot: Record<string, string> = {};
  const authorityV1: Record<string, string> = {};
  for (const file of FILES) {
    const text = await readOptional(join(opts.projectDir, ".cleetus", file));
    if (text !== null) {
      snapshot[file] = hash(text);
      authorityV1[file] = authorityDigest(text, file);
    }
  }
  if (expected && JSON.stringify(expected) !== JSON.stringify(snapshot)) {
    throw new Error("Project configuration changed during approval; review it again.");
  }
  writePrivateFile(record, JSON.stringify({ ...snapshot, authorityV1 }));
}

/** An explicit saved permission decision approves only the bytes just written, not other files. */
export async function approveSavedProjectPermissions(
  opts: ProjectTrustOptions,
  expectedText: string,
): Promise<void> {
  const path = await recordPath(opts);
  const text = await readOptional(join(opts.projectDir, ".cleetus", "permissions.yaml"));
  if (text !== expectedText) throw new Error("Project permissions changed while saving approval.");
  const record = await readRecord(path);
  record["permissions.yaml"] = hash(text);
  record.authorityV1 = {
    ...record.authorityV1,
    "permissions.yaml": authorityDigest(text, "permissions.yaml"),
  };
  privateDirectory(dirname(path));
  writePrivateFile(path, JSON.stringify(record));
}

/** Return the bytes checked for approved authority, avoiding a check-then-reread window. */
export async function readTrustedProjectFile(
  opts: ProjectTrustOptions,
  file: ConfigFile,
): Promise<string | null> {
  const text = await readOptional(join(opts.projectDir, ".cleetus", file));
  if (text === null) return null;
  let approved: TrustRecord = {};
  try {
    approved = await readRecord(await recordPath(opts));
  } catch {
    /* Missing, invalid or unsafe trust records never grant authority. */
  }
  let trusted = approved[file] === hash(text);
  if (!trusted && typeof approved.authorityV1?.[file] === "string") {
    try {
      trusted = approved.authorityV1[file] === authorityDigest(text, file);
    } catch {
      // Invalid YAML never matches an approved configuration.
    }
  }
  if (!trusted) {
    throw new CleetusError(
      "CONFIG_INVALID",
      `Untrusted project configuration:\n  ${join(opts.projectDir, ".cleetus", file)}\n\nReview the file, then run:\n\n  ${projectTrustCommand(opts)}\n\nChanges to security-relevant settings require approval again.`,
    );
  }
  return text;
}
