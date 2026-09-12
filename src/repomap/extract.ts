import { extname } from "node:path";
import type { RepoSymbol, SymbolKind } from "./types";

interface Pattern {
  re: RegExp;
  kind: SymbolKind;
  /** Fallback name when the capture group is empty (e.g. nameless default export). */
  defaultName?: string;
}

// Anchored at ^ with no leading whitespace → column-0 / top-level only.
// Ordered: more specific (export …) before bare forms. First match per line wins.
const TS_PATTERNS: Pattern[] = [
  { re: /^export\s+const\s+([A-Za-z_$][\w$]*)/, kind: "const" },
  { re: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  {
    re: /^export\s+default\s+(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?/,
    kind: "function",
    defaultName: "default",
  },
  {
    re: /^export\s+default\s+(?:abstract\s+)?class\s*([A-Za-z_$][\w$]*)?/,
    kind: "class",
    defaultName: "default",
  },
  { re: /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
];

const PY_PATTERNS: Pattern[] = [
  { re: /^def\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^class\s+([A-Za-z_]\w*)/, kind: "class" },
];

const GO_PATTERNS: Pattern[] = [
  { re: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/, kind: "function" },
  { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: "struct" },
  { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: "interface" },
];

const TS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function patternsFor(relPath: string): Pattern[] | null {
  const ext = extname(relPath);
  if (TS_EXT.has(ext)) return TS_PATTERNS;
  if (ext === ".py") return PY_PATTERNS;
  if (ext === ".go") return GO_PATTERNS;
  return null;
}

export function extractSymbols(relPath: string, content: string): RepoSymbol[] {
  const patterns = patternsFor(relPath);
  if (!patterns) return [];
  const out: RepoSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (m) {
        const name = m[1] ?? p.defaultName;
        if (name) out.push({ name, kind: p.kind, line: i + 1 });
        break; // one symbol per line
      }
    }
  }
  return out;
}
