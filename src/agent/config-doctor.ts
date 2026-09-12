/** A project's relevant files for wiring checks. Built by config-doctor-scan; consumed by rules. */
export interface ProjectSnapshot {
  root: string; // project dir relative to cwd ("." for the root)
  packageJson: string | null; // raw contents
  viteConfigPath: string | null; // e.g. "app/vite.config.ts", or null if absent
  viteConfigContent: string | null;
}

export interface Violation {
  rule: string; // rule id, e.g. "tailwind-v4-vite-plugin"
  problem: string; // human description for the notice
  fix: string; // concrete, self-contained instruction for a corrective worker
}

type Rule = (snap: ProjectSnapshot) => Violation | null;

/** Major version from a package.json range ("^4.3.1" -> 4, "4" -> 4, "~3.x" -> 3); null if none. */
function majorVersion(range: string | undefined): number | null {
  if (!range) return null;
  const m = /(\d+)/.exec(range);
  return m ? Number(m[1]) : null;
}

/** Merged dependencies + devDependencies from a parsed package.json. */
function allDeps(pkg: Record<string, unknown>): Record<string, string> {
  return {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };
}

/** Tailwind v4 needs the @tailwindcss/vite plugin wired into the Vite config (or the PostCSS
 *  path). If v4 is installed but the vite config never references @tailwindcss/vite, no CSS is
 *  generated — the app renders unstyled. */
const tailwindV4VitePlugin: Rule = (snap) => {
  if (!snap.packageJson) return null;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(snap.packageJson);
  } catch {
    return null;
  }
  const deps = allDeps(pkg);
  const twMajor = majorVersion(deps.tailwindcss);
  const usesV4 = (twMajor !== null && twMajor >= 4) || "@tailwindcss/vite" in deps;
  if (!usesV4) return null;
  if ("@tailwindcss/postcss" in deps) return null; // PostCSS wiring — out of scope, not a defect
  if (!snap.viteConfigContent || !snap.viteConfigPath) return null; // nothing to assert against
  if (snap.viteConfigContent.includes("@tailwindcss/vite")) return null; // plugin imported -> wired
  return {
    rule: "tailwind-v4-vite-plugin",
    problem: `Tailwind v4 is installed but the @tailwindcss/vite plugin is not wired into ${snap.viteConfigPath}, so no CSS is generated.`,
    fix: `In ${snap.viteConfigPath}, wire the Tailwind v4 Vite plugin: add the import \`import tailwindcss from '@tailwindcss/vite'\` and include \`tailwindcss()\` in the Vite \`plugins\` array (e.g. \`plugins: [react(), tailwindcss()]\`). Keep all existing plugins. Do not change anything else.`,
  };
};

const RULES: Rule[] = [tailwindV4VitePlugin];

/** Run all wiring rules against a project snapshot; returns the violations found (possibly empty). */
export function runRules(snap: ProjectSnapshot): Violation[] {
  return RULES.map((r) => r(snap)).filter((v): v is Violation => v !== null);
}
