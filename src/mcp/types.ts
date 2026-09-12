import type { McpServerConfig } from "../config/types";

/** A server config plus the name it was declared under. */
export interface NamedServerConfig extends McpServerConfig {
  name: string;
}

/** One content part returned by an MCP tool call. */
export type McpContent = { type: "text"; text: string } | { type: string; [k: string]: unknown };

/** A tool as advertised by an MCP server's tools/list. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: object;
}

/** Result of an MCP tools/call. */
export interface McpCallResult {
  content: McpContent[];
  isError: boolean;
}

/**
 * Transport-agnostic view of one server connection. The real implementation
 * (src/mcp/client.ts) wraps the SDK; tests inject a fake.
 */
export interface McpConnection {
  connect(): Promise<void>;
  listTools(): Promise<McpToolDef[]>;
  callTool(toolName: string, args: unknown, signal: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

export type ClientFactory = (server: NamedServerConfig) => McpConnection;

export type McpServerState = "connected" | "failed" | "disabled";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  toolCount: number;
  toolNames: string[];
  error?: string;
}
