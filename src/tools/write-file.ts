import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DirectFileBridge, type FileBridge } from "../acp/file-bridge";
import { refuseIfSecretPath } from "./read-guard";
import type { Tool, ToolContext, ToolResult } from "./types";
import { refuseIfOutsideProject } from "./within-project";

interface Args {
  path: string;
  content: string;
}

export class WriteFileTool implements Tool {
  private readonly fileBridge: FileBridge;
  constructor(fileBridge: FileBridge = new DirectFileBridge()) {
    this.fileBridge = fileBridge;
  }
  name = "write_file";
  mutates = true;
  description = "Write content to a file, overwriting it. Creates parent directories.";
  parameters = {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  };
  serialize(args: unknown): string {
    const a = args as Args;
    return `write_file ${a.path} (${a.content.length} bytes)`;
  }
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as Args;
    const refusal = await refuseIfOutsideProject(a.path, ctx);
    if (refusal) return refusal;
    const secretRefusal = await refuseIfSecretPath(a.path, ctx);
    if (secretRefusal) return secretRefusal;
    const path = resolve(ctx.projectDir, a.path);
    try {
      let before = "";
      let created = false;
      try {
        before = await this.fileBridge.readTextFile(path);
      } catch {
        // missing file → new file → before stays "", created flips true
        created = true;
      }
      await mkdir(dirname(path), { recursive: true });
      const finalRefusal = await refuseIfOutsideProject(a.path, ctx);
      if (finalRefusal) return finalRefusal;
      await this.fileBridge.writeTextFile(path, a.content);
      return {
        ok: true,
        output: `wrote ${a.content.length} bytes to ${path}`,
        diff: { path, before, after: a.content, created },
      };
    } catch (e) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: (e as Error).message };
    }
  }
}
