import type { McpServerConfig } from "../config/types";
import type { EventLog } from "../events/log";
import { McpManager, createStdioConnection } from "../mcp";
import type { ClientFactory, McpServerStatus, NamedServerConfig } from "../mcp/types";
import type { ToolRegistry } from "../tools/registry";

export interface ConfiguredAcpMcp {
  names: Set<string>;
  statuses: McpServerStatus[];
  shutdown(): Promise<void>;
}

/** Connect Cleetus-owned MCP servers from merged global/project config and register their tools. */
export async function connectConfiguredAcpMcp(input: {
  servers: Record<string, McpServerConfig>;
  tools: ToolRegistry;
  log: EventLog;
  factory?: ClientFactory;
}): Promise<ConfiguredAcpMcp> {
  const servers: NamedServerConfig[] = Object.entries(input.servers).map(([name, config]) => ({
    name,
    ...config,
  }));
  const manager = new McpManager({
    servers,
    factory: input.factory ?? createStdioConnection,
    log: input.log,
    timeoutMs: 10_000,
  });
  await manager.connectAll();
  manager.registerInto(input.tools);
  return {
    names: new Set(servers.map((server) => server.name)),
    statuses: manager.status(),
    shutdown: () => manager.shutdown(),
  };
}
