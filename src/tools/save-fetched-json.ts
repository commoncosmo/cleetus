import type { FileBridge } from "../acp/file-bridge";
import type { WebFetchCache } from "../web/fetch-cache";
import type { Tool, ToolContext, ToolResult } from "./types";
import { WriteFileTool } from "./write-file";

interface Args {
  url: string;
  path: string;
}

/** Save a complete JSON response already present in the session web cache. The model supplies
 * only URL and destination, so a large payload never has to survive model token generation. */
export class SaveFetchedJsonTool implements Tool {
  name = "save_fetched_json";
  mutates = true;
  description =
    "Save the exact complete JSON body from an earlier successful web_fetch to a file. Use this instead of copying a large fetched JSON object into write_file. Requires the same URL to be present and untruncated in this session's web_fetch cache.";
  parameters = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The exact URL previously passed to web_fetch",
      },
      path: {
        type: "string",
        description: "Destination path inside the project",
      },
    },
    required: ["url", "path"],
  };
  private readonly writer: WriteFileTool;

  constructor(
    private readonly cache: WebFetchCache,
    fileBridge?: FileBridge,
  ) {
    this.writer = new WriteFileTool(fileBridge);
  }

  serialize(args: unknown): string {
    const value = args as Args;
    return `save_fetched_json ${value.url} -> ${value.path}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const value = args as Args;
    const cached = this.cache.get(value.url);
    if (!cached) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "that URL is not in this session's web_fetch cache; fetch it successfully first",
      };
    }
    if (cached.complete === false || cached.body.endsWith("\n[truncated]")) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: "the cached response was truncated; it cannot be saved as an exact artifact",
      };
    }
    try {
      JSON.parse(cached.body);
    } catch {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: "the cached response is not valid JSON",
      };
    }
    const result = await this.writer.run({ path: value.path, content: cached.body }, ctx);
    return result.ok
      ? {
          ...result,
          output: `saved exact cached JSON from ${cached.finalUrl} to ${result.diff?.path ?? value.path}`,
        }
      : result;
  }
}
