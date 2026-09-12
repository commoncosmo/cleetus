#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "0.0.0" });

server.tool("echo", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text" as const, text }],
}));

await server.connect(new StdioServerTransport());
