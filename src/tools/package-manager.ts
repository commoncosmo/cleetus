/** A foreign package-manager invocation at the start of the command or right after a shell operator
 * (`;`, `&&`, `||`, `|`, `&`), so a Bun command that merely mentions "npm" inside an argument or a
 * quoted string is not matched. Captures the tool and the rest of that segment. */
const FOREIGN_PM_RE =
  /(?:^|[;&|]\s*|&&\s*|\|\|\s*)\s*(?:[A-Za-z_][\w]*=[^\s;&|]*\s+)*(npx|npm|yarn|pnpm)\b([^\n;&|]*)/i;

/** Cheap pre-check so the caller can skip the (filesystem) bun-project probe on ordinary commands. */
export function commandInvokesForeignPackageManager(command: string): boolean {
  return FOREIGN_PM_RE.test(command);
}

export interface PackageManagerDecision {
  blocked: boolean;
  message?: string;
}

/** Map a foreign package-manager invocation to its Bun equivalent, for the corrective message. */
function bunEquivalent(tool: string, rest: string): string {
  const trimmed = rest.trim();
  if (tool === "npx") return `bunx ${trimmed}`.trim();
  const args = trimmed.split(/\s+/).filter(Boolean);
  const sub = (args[0] ?? "").toLowerCase();
  const tail = args.slice(1).join(" ");
  if (sub === "install" || sub === "i") return tail ? `bun add ${tail}` : "bun install";
  if (sub === "add") return `bun add ${tail}`.trim();
  if (sub === "ci") return "bun install";
  if (sub === "run") return `bun run ${tail}`.trim();
  if (sub === "test" || sub === "t") return tail ? `bun test ${tail}`.trim() : "bun test";
  if (sub === "exec" || sub === "dlx") return `bunx ${tail}`.trim();
  if (sub === "create") return `bun create ${tail}`.trim();
  if (sub === "remove" || sub === "uninstall" || sub === "rm") return `bun remove ${tail}`.trim();
  if (!sub) return "bun install"; // bare `yarn` / `pnpm` == install
  return `bun ${trimmed}`.trim();
}

/** In a Bun project (a bun lockfile is present), a foreign package manager is the wrong tool: it
 * writes a competing lockfile, resolves dependencies differently, and violates a bun-only setup that
 * models are told to honor but small ones ignore. Block it with the Bun equivalent so the turn is
 * corrected rather than silently drifting the toolchain. This is toolchain-consistency, not a
 * security guard — it fires only once the project has already committed to Bun, so it never forces
 * Bun onto an npm/yarn/pnpm project. */
export function packageManagerDecision(input: {
  command: string;
  bunProject: boolean;
}): PackageManagerDecision {
  if (!input.bunProject) return { blocked: false };
  const match = input.command.match(FOREIGN_PM_RE);
  if (!match) return { blocked: false };
  const tool = match[1]!.toLowerCase();
  const suggestion = bunEquivalent(tool, match[2] ?? "");
  const use = suggestion ? `: \`${suggestion}\`` : "";
  const message = [
    `This is a Bun project (a bun lockfile is present), but the command uses \`${tool}\`.`,
    `Use Bun instead${use}.`,
    "Bun equivalents: `bunx` for `npx`, `bun install` for `npm install`/`ci`,",
    "`bun add [-d] <pkg>` for `npm install [-D] <pkg>`, `bun run <script>` (or `bun test`) for",
    "`npm run <script>`. Re-run with the Bun equivalent.",
  ].join(" ");
  return { blocked: true, message };
}
