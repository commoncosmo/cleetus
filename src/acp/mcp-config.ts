import type { NamedServerConfig } from "../mcp/types";

/** Normalize an ACP MCP server's `env` field to `Record<string,string>`.
 *  ACP specifies env as `EnvVariable[]` = `{ name: string, value: string }[]`, but a plain
 *  `Record<string,string>` is also accepted for back-compat. Malformed array entries are skipped. */
function normalizeEnv(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const item of raw) {
      if (item && typeof item === "object" && "name" in item && "value" in item) {
        const { name, value } = item as { name: unknown; value: unknown };
        if (typeof name === "string" && typeof value === "string") out[name] = value;
      }
    }
    return out;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, string>;
  return {};
}

/** Map the ACP `session/new`/`session/load` `mcpServers` array onto cleetus's NamedServerConfig
 *  (`{ name, command, args, env, enabled }`). Malformed entries (missing name or command) and
 *  non-array inputs are skipped, not thrown. */
export function acpMcpServersToConfigs(
  servers: unknown,
  reservedNames: ReadonlySet<string> = new Set(),
): NamedServerConfig[] {
  if (!Array.isArray(servers)) return [];
  const out: NamedServerConfig[] = [];
  for (const s of servers) {
    const e = s as { name?: unknown; command?: unknown; args?: unknown; env?: unknown };
    if (typeof e.name !== "string" || typeof e.command !== "string" || reservedNames.has(e.name)) {
      continue;
    }
    out.push({
      name: e.name,
      command: e.command,
      args: Array.isArray(e.args) ? (e.args as string[]) : [],
      env: normalizeEnv(e.env),
      enabled: true,
    });
  }
  return out;
}
