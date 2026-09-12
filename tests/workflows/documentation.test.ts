import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowModelCallService } from "../../src/workflows/model-call";
import { loadWorkflowPackage } from "../../src/workflows/package";
import { createBuiltinWorkflowStepRegistry } from "../../src/workflows/steps";
import { parseWorkflowTestCase } from "../../src/workflows/test-case";
import { runWorkflowTestCase } from "../../src/workflows/test-runner";
import { validateWorkflowPackage } from "../../src/workflows/validate";

function yamlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```yaml\n([\s\S]*?)\n```/gu)].map((match) => match[1]!);
}

describe("workflow documentation", () => {
  test("the manual-authoring guide covers the package and complete built-in action roster", () => {
    const guidePath = fileURLToPath(
      new URL("../../docs/workflows/manual-authoring.md", import.meta.url),
    );
    const guide = readFileSync(guidePath, "utf8");

    for (const value of [
      "cleetus workflow init <name>",
      "`workflow.yaml`",
      "`SKILL.md`",
      "`prompts/`",
      "`scripts/`",
      "`tests/*.yaml` or `tests/*.json`",
      "`http.request@1`",
      "`llm.generate@1`",
      "`data.select@1`",
      "`text.template@1`",
      "`assert.schema@1`",
      "`command.run@1`",
      "managed manual revision",
    ]) {
      expect(guide).toContain(value);
    }
  });

  test("the authoring guide's complete package validates and its offline test passes", async () => {
    const guidePath = fileURLToPath(new URL("../../docs/workflows/authoring.md", import.meta.url));
    const [manifest, testCaseSource] = yamlBlocks(readFileSync(guidePath, "utf8"));
    expect(manifest).toBeDefined();
    expect(testCaseSource).toBeDefined();
    if (!manifest || !testCaseSource) throw new Error("documented YAML examples are missing");

    const root = mkdtempSync(join(tmpdir(), "workflow-docs-"));
    const packageDir = join(root, "weather");
    mkdirSync(join(packageDir, "tests"), { recursive: true });
    writeFileSync(join(packageDir, "workflow.yaml"), `${manifest}\n`);
    writeFileSync(join(packageDir, "tests", "success.yaml"), `${testCaseSource}\n`);

    const pkg = loadWorkflowPackage(packageDir, "project");
    const registry = createBuiltinWorkflowStepRegistry({
      packageDir,
      modelCalls: new WorkflowModelCallService(() => {
        throw new Error("provider must not be called by a mocked documentation test");
      }),
      sandbox: {
        async exec() {
          throw new Error("sandbox must not be called by a mocked documentation test");
        },
        async dispose() {},
        writeRoot: () => null,
      },
      transport: async () => {
        throw new Error("network must not be called by a mocked documentation test");
      },
    });

    expect(validateWorkflowPackage(pkg, registry).issues).toEqual([]);
    const testCase = parseWorkflowTestCase(testCaseSource, "documented-success.yaml");
    expect(await runWorkflowTestCase(pkg, registry, testCase)).toEqual({
      name: "renders four weather bullets",
      passed: true,
      failures: [],
    });
  });
});
