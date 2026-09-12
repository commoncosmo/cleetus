import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProject } from "../../src/agent/config-doctor-scan";

const pkgVite = (extra: Record<string, string> = {}) =>
  JSON.stringify({ devDependencies: { vite: "^8.0.0", ...extra } });

test("finds a NESTED vite project with the Tailwind bug and reports its config path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleetus-doctor-"));
  await mkdir(join(dir, "app"), { recursive: true });
  await writeFile(join(dir, "app", "package.json"), pkgVite({ tailwindcss: "^4.3.1" }));
  await writeFile(join(dir, "app", "vite.config.ts"), "export default { plugins: [react()] }");
  const v = await inspectProject(dir);
  expect(v).toHaveLength(1);
  expect(v[0]!.rule).toBe("tailwind-v4-vite-plugin");
  expect(v[0]!.problem).toContain("app/vite.config.ts");
  await rm(dir, { recursive: true, force: true });
});

test("prunes node_modules (does not scan a nested package.json there)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleetus-doctor-nm-"));
  await mkdir(join(dir, "node_modules", "somepkg"), { recursive: true });
  await writeFile(
    join(dir, "node_modules", "somepkg", "package.json"),
    pkgVite({ tailwindcss: "^4.3.1" }),
  );
  await writeFile(join(dir, "node_modules", "somepkg", "vite.config.ts"), "plugins: [react()]");
  expect(await inspectProject(dir)).toEqual([]);
  await rm(dir, { recursive: true, force: true });
});

test("ignores a project that does not depend on vite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleetus-doctor-novite-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { tailwindcss: "^4.3.1" } }),
  );
  await writeFile(join(dir, "vite.config.ts"), "plugins: [react()]");
  expect(await inspectProject(dir)).toEqual([]);
  await rm(dir, { recursive: true, force: true });
});

test("returns nothing when the vite project is correctly wired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleetus-doctor-ok-"));
  await writeFile(join(dir, "package.json"), pkgVite({ tailwindcss: "^4.3.1" }));
  await writeFile(
    join(dir, "vite.config.ts"),
    "import tailwindcss from '@tailwindcss/vite'\nplugins: [react(), tailwindcss()]",
  );
  expect(await inspectProject(dir)).toEqual([]);
  await rm(dir, { recursive: true, force: true });
});
