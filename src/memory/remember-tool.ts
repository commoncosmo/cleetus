import type { Tool, ToolContext, ToolResult } from "../tools/types";
import type { MemoryStore } from "./store";
import type { MemoryScope } from "./types";

interface Args {
  text: string;
  scope?: MemoryScope;
}

export class RememberTool implements Tool {
  name = "remember";
  description: string;
  parameters = {
    type: "object",
    properties: {
      text: { type: "string" },
      scope: { type: "string", enum: ["global", "project"], description: "default project" },
    },
    required: ["text"],
  };

  constructor(
    private readonly stores: { global: MemoryStore; project: MemoryStore },
    private readonly defaultScope: MemoryScope = "project",
  ) {
    this.description = `Save a durable fact to remember across sessions. Use scope \`project\` for facts about this codebase (conventions, decisions, architecture); use \`global\` for durable personal preferences that apply everywhere. Keep each memory to one concise sentence. Default scope: ${defaultScope}.`;
  }

  serialize(args: unknown): string {
    const a = args as Args;
    return `remember (${a.scope ?? this.defaultScope}) ${a.text}`;
  }

  async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const a = args as Args;
    const text = (a.text ?? "").trim();
    if (!text) return { ok: true, output: "nothing to remember (empty text)" };
    const scope: MemoryScope =
      a.scope === "global" ? "global" : a.scope === "project" ? "project" : this.defaultScope;
    const store = this.stores[scope];
    store.add(text);
    // Report the real file path so the model can answer "where did you save it?" from fact rather
    // than confabulating a plausible-looking location.
    return { ok: true, output: `remembered (${scope}) → ${store.path}: ${text}` };
  }
}
