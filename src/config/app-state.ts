import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Small persisted app state under the config root (`~/.config/cleetus/state.yaml`) — one-time
 *  acknowledgments and similar flags that are neither config (user-authored) nor per-project.
 *  Advisory: any read/parse failure degrades to empty state, never a startup crash. */
export interface AppState {
  /** User acknowledged running with a silently-degraded (unconfined) sandbox. */
  sandboxDegradedAck?: boolean;
}

function stateFile(configRoot: string): string {
  return join(configRoot, "state.yaml");
}

async function readRaw(configRoot: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(stateFile(configRoot), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = parseYaml(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readAppState(configRoot: string): Promise<AppState> {
  const raw = await readRaw(configRoot);
  const out: AppState = {};
  if (raw.sandbox_degraded_ack === true) out.sandboxDegradedAck = true;
  return out;
}

export async function writeAppState(configRoot: string, patch: Partial<AppState>): Promise<void> {
  const raw = await readRaw(configRoot);
  if (patch.sandboxDegradedAck !== undefined) {
    raw.sandbox_degraded_ack = patch.sandboxDegradedAck;
  }
  await mkdir(configRoot, { recursive: true });
  await writeFile(stateFile(configRoot), stringifyYaml(raw));
}
