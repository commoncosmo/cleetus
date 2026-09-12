import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  McpCallResult,
  McpConnection,
  McpContent,
  McpToolDef,
  NamedServerConfig,
} from "./types";

/** process.env has `string | undefined` values; the SDK wants `Record<string,string>`. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function createStdioConnection(server: NamedServerConfig): McpConnection {
  let client: Client | null = null;
  return {
    async connect(): Promise<void> {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...cleanEnv(process.env), ...server.env },
      });
      client = new Client({ name: "cleetus", version: "0.0.0" }, { capabilities: {} });
      await client.connect(transport);
    },
    async listTools(): Promise<McpToolDef[]> {
      if (!client) throw new Error("not connected");
      const res = await client.listTools();
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as object,
      }));
    },
    async callTool(toolName: string, args: unknown, signal: AbortSignal): Promise<McpCallResult> {
      if (!client) throw new Error("not connected");
      const res = await client.callTool(
        { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { signal },
      );
      return {
        content: (res.content ?? []) as McpContent[],
        isError: res.isError === true,
      };
    },
    async close(): Promise<void> {
      await client?.close();
      client = null;
    },
  };
}
