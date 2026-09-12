import type { Message, ToolCall } from "../providers/types";

const IMPLEMENTATION_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.json",
  "deno.jsonc",
  "composer.json",
  "cargo.toml",
  "go.mod",
  "go.sum",
  "gemfile",
  "dockerfile",
  "makefile",
  "pyproject.toml",
  "ruff.toml",
  "bunfig.toml",
]);

const SOURCE_EXTENSION_RE =
  /\.(?:[cm]?[jt]sx?|mjs|cjs|py|pyi|rb|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hh|hpp|cs|php|scala|sh|bash|zsh|fish|lua|ex|exs|erl|hrl|clj|cljs|vue|svelte|astro|sql|graphql|gql|proto|css|scss|sass|less|html|htm)$/i;

/** True when a changed path is executable source, test, build/runtime configuration, or another
 * implementation-bearing file. Generic data/document artifacts intentionally return false. */
export function isImplementationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (IMPLEMENTATION_BASENAMES.has(basename)) return true;
  if (/^(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json$/i.test(basename)) return true;
  if (
    /^(?:vite|vitest|eslint|prettier|biome|webpack|rollup|babel|jest)\.config\./i.test(basename)
  ) {
    return true;
  }
  if (
    /^(?:(?:app|application|runtime|project|cleetus)\.)?config\.(?:json|ya?ml|toml)$/i.test(
      basename,
    )
  ) {
    return true;
  }
  if (/^(?:compose|docker-compose)\.ya?ml$/i.test(basename)) return true;
  if (/^(?:\.env(?:\..+)?|\.npmrc)$/i.test(basename)) return true;
  if (
    /(?:^|\/)(?:\.github|\.gitlab|\.husky|migrations?|config|deploy|k8s|helm)\//i.test(normalized)
  ) {
    return true;
  }
  return SOURCE_EXTENSION_RE.test(normalized);
}

function pathsFromWriteCall(call: ToolCall): string[] {
  const args = call.args as Record<string, unknown> | undefined;
  if (call.name === "write_file" || call.name === "edit_file" || call.name === "multi_edit") {
    const path = args?.path ?? args?.file_path;
    return typeof path === "string" ? [path] : [];
  }
  if (call.name !== "apply_patch" || typeof args?.patch !== "string") return [];
  return [...args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((m) =>
    m[1]!.trim(),
  );
}

/** Structural source/config-write signal from the current turn's assistant tool calls. */
export function hasImplementationWrite(messages: Message[]): boolean {
  return messages.some((message) =>
    message.toolCalls?.some((call) => pathsFromWriteCall(call).some(isImplementationPath)),
  );
}
