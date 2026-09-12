import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowModelCallService } from "../../src/workflows/model-call";
import { loadWorkflowPackage } from "../../src/workflows/package";
import { createBuiltinWorkflowStepRegistry } from "../../src/workflows/steps";
import { parseWorkflowTestCase } from "../../src/workflows/test-case";
import { runWorkflowTestCase } from "../../src/workflows/test-runner";
import { validateWorkflowPackage } from "../../src/workflows/validate";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/workflows/repository-brief",
);

describe("repository brief workflow acceptance", () => {
  test("selects, validates, and presents a mocked HTTP response without external calls", async () => {
    const pkg = loadWorkflowPackage(fixture, "project");
    const registry = createBuiltinWorkflowStepRegistry({
      packageDir: pkg.dir,
      modelCalls: new WorkflowModelCallService(() => {
        throw new Error("provider must not be called");
      }),
      sandbox: {
        async exec() {
          throw new Error("sandbox must not be called");
        },
        async dispose() {},
        writeRoot: () => null,
      },
      transport: async () => {
        throw new Error("network must not be called");
      },
    });

    expect(pkg.manifest.steps.map((step) => step.uses)).toEqual([
      "http.request@1",
      "data.select@1",
      "assert.schema@1",
      "text.template@1",
    ]);
    expect(validateWorkflowPackage(pkg, registry).issues).toEqual([]);
    const testCase = parseWorkflowTestCase(
      readFileSync(join(pkg.dir, "tests", "success.yaml"), "utf8"),
    );
    expect(await runWorkflowTestCase(pkg, registry, testCase)).toEqual({
      name: "renders selected and validated repository metadata",
      passed: true,
      failures: [],
    });
  });
});
