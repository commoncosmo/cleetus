import { resolve } from "node:path";
import { DirectFileBridge, type FileBridge } from "../acp/file-bridge";
import { refuseIfSecretPath } from "./read-guard";
import type { Tool, ToolContext, ToolResult } from "./types";

interface Args {
  path: string;
  offset?: number;
  limit?: number;
}

export class ReadFileTool implements Tool {
  private readonly fileBridge: FileBridge;
  constructor(fileBridge: FileBridge = new DirectFileBridge()) {
    this.fileBridge = fileBridge;
  }
  name = "read_file";
  description =
    "Read the contents of a file. Optional offset (1-based starting line) and limit (number of lines).";
  parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "File path relative to the working directory (an absolute path also works). " +
          "Prefer relative — you never need to retype the project root.",
      },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["path"],
  };

  serialize(args: unknown): string {
    const a = args as Args;
    return `read_file ${a.path}${a.offset ? ` @${a.offset}` : ""}${a.limit ? `/${a.limit}` : ""}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as Args;
    const secret = await refuseIfSecretPath(a.path, ctx);
    if (secret) return secret;
    const path = resolve(ctx.projectDir, a.path);
    try {
      const text = await this.fileBridge.readTextFile(path);
      let out = text;
      if (a.offset || a.limit) {
        const lines = text.split("\n");
        const start = (a.offset ?? 1) - 1;
        const end = a.limit ? start + a.limit : lines.length;
        out = lines.slice(start, end).join("\n");
      }
      return { ok: true, output: out };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EISDIR") {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: `${a.path} is a directory, not a file. Use the glob tool to list its contents.`,
        };
      }
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: err.message };
    }
  }
}
