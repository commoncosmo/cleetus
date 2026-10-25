import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WindowsSandbox } from "../src/sandbox/windows";
import { ScaffoldTool } from "../src/tools/scaffold";

mkdirSync("dist/scaffold-smoke", { recursive: true });
const project = mkdtempSync(join(resolve("dist/scaffold-smoke"), "project-"));
mkdirSync(join(project, ".cleetus"));
writeFileSync(join(project, ".cleetus/sentinel"), "preserved");
const executor = resolve(
  process.argv[2] ?? `dist/cleetus-windows-${process.arch}/native/wxc-exec.exe`,
);
const sandbox = new WindowsSandbox(project, true, executor);
try {
  assert.equal(await sandbox.healthCheck(), null);
  const result = await new ScaffoldTool(sandbox).run(
    { command: "bunx create-vite@9.3.1 . --template react-ts" },
    { projectDir: project, abortSignal: new AbortController().signal },
  );
  console.log(JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.ok(JSON.parse(readFileSync(join(project, "package.json"), "utf8")).scripts.build);
  assert.ok(readFileSync(join(project, "vite.config.ts"), "utf8").includes("defineConfig"));
  assert.equal(readFileSync(join(project, ".cleetus/sentinel"), "utf8"), "preserved");
  console.log(`WINDOWS_SCAFFOLD_PASS ${project}`);
} finally {
  await sandbox.dispose();
}
