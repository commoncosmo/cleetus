import { CleetusError } from "../lib/errors";
import type { Tool, ToolContext, ToolResult } from "../tools/types";
import type { NamespaceStats, Scope, VectorHit } from "../vector/types";

interface Args {
  query: string;
  k?: number;
}

const NAMESPACE = "code";
const DEFAULT_K = 5;
const MAX_K = 10;

export interface CodeSearchBackend {
  readonly enabled: boolean;
  stats(scope: Scope, namespace: string): NamespaceStats;
  search(scope: Scope, namespace: string, query: string, k: number): Promise<VectorHit[]>;
}

export class CodeSearchTool implements Tool {
  name = "code_search";
  description =
    "Semantic search over the indexed codebase. Returns relevant code chunks with file paths and line ranges. Run /index first if results are empty.";
  parameters = {
    type: "object",
    properties: {
      query: { type: "string" },
      k: {
        type: "integer",
        minimum: 1,
        maximum: MAX_K,
        description: `max results (default ${DEFAULT_K})`,
      },
    },
    required: ["query"],
  };

  constructor(
    private readonly vectors:
      | CodeSearchBackend
      | ((projectDir: string) => CodeSearchBackend | undefined),
  ) {}

  serialize(args: unknown): string {
    return `code_search ${(args as Args).query}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = args as Args;
    const vectors =
      typeof this.vectors === "function" ? this.vectors(ctx.projectDir) : this.vectors;
    if (!vectors?.enabled) {
      return {
        ok: true,
        output: "code search unavailable — set an `embeddings` block in config.yaml",
      };
    }
    if (vectors.stats("project", NAMESPACE).count === 0) {
      return { ok: true, output: "no code index yet — run /index" };
    }
    const k = Math.min(Math.max(1, a.k ?? DEFAULT_K), MAX_K);
    try {
      const hits = await vectors.search("project", NAMESPACE, a.query, k);
      if (hits.length === 0) return { ok: true, output: "no matches" };
      const blocks = hits.map((h) => {
        const m = h.metadata as { path: string; startLine: number; endLine: number };
        return `${m.path}:${m.startLine}-${m.endLine}  (${h.score.toFixed(2)})\n${h.text}`;
      });
      return { ok: true, output: blocks.join("\n\n") };
    } catch (e) {
      if (e instanceof CleetusError && e.code === "EMBEDDING_MODEL_MISMATCH") {
        return {
          ok: true,
          output: "index was built with a different embedding model — run /index to rebuild",
        };
      }
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: (e as Error).message };
    }
  }
}
