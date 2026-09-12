import { expect, test } from "bun:test";
import { type ProjectSnapshot, runRules } from "../../src/agent/config-doctor";

function snap(over: Partial<ProjectSnapshot>): ProjectSnapshot {
  return {
    root: "app",
    packageJson: null,
    viteConfigPath: "app/vite.config.ts",
    viteConfigContent: null,
    ...over,
  };
}
const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ dependencies: deps, devDependencies: dev });

test("flags Tailwind v4 when the vite config lacks the plugin", () => {
  const v = runRules(
    snap({
      packageJson: pkg({ tailwindcss: "^4.3.1" }),
      viteConfigContent: "export default defineConfig({ plugins: [react()] })",
    }),
  );
  expect(v).toHaveLength(1);
  expect(v[0]!.rule).toBe("tailwind-v4-vite-plugin");
  expect(v[0]!.problem).toContain("app/vite.config.ts");
  expect(v[0]!.fix).toContain("@tailwindcss/vite");
});

test("passes when the vite config already references @tailwindcss/vite", () => {
  expect(
    runRules(
      snap({
        packageJson: pkg({ tailwindcss: "^4.3.1" }),
        viteConfigContent:
          "import tailwindcss from '@tailwindcss/vite'\nplugins: [react(), tailwindcss()]",
      }),
    ),
  ).toEqual([]);
});

test("treats @tailwindcss/vite in deps (no explicit tailwindcss) as v4", () => {
  expect(
    runRules(
      snap({
        packageJson: pkg({}, { "@tailwindcss/vite": "^4.3.1" }),
        viteConfigContent: "plugins: [react()]",
      }),
    ),
  ).toHaveLength(1);
});

test("passes when wired via PostCSS (@tailwindcss/postcss present)", () => {
  expect(
    runRules(
      snap({
        packageJson: pkg({ tailwindcss: "^4.3.1", "@tailwindcss/postcss": "^4.3.1" }),
        viteConfigContent: "plugins: [react()]",
      }),
    ),
  ).toEqual([]);
});

test("ignores Tailwind v3", () => {
  expect(
    runRules(
      snap({
        packageJson: pkg({ tailwindcss: "^3.4.1" }),
        viteConfigContent: "plugins: [react()]",
      }),
    ),
  ).toEqual([]);
});

test("no-op when Tailwind is absent", () => {
  expect(
    runRules(snap({ packageJson: pkg({ react: "^19" }), viteConfigContent: "plugins: [react()]" })),
  ).toEqual([]);
});

test("no-op when there is no vite config to assert against", () => {
  expect(
    runRules(
      snap({
        packageJson: pkg({ tailwindcss: "^4.3.1" }),
        viteConfigContent: null,
        viteConfigPath: null,
      }),
    ),
  ).toEqual([]);
});

test("no-op on unparseable package.json", () => {
  expect(runRules(snap({ packageJson: "{ not json", viteConfigContent: "plugins: []" }))).toEqual(
    [],
  );
});
