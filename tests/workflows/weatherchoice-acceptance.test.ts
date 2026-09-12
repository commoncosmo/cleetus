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
  "../fixtures/workflows/weatherchoice",
);

describe("weatherchoice workflow acceptance", () => {
  test("validates and passes its complete offline comparison", async () => {
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

    expect(validateWorkflowPackage(pkg, registry).issues).toEqual([]);
    const testCase = parseWorkflowTestCase(
      readFileSync(join(pkg.dir, "tests", "success.yaml"), "utf8"),
    );
    expect(await runWorkflowTestCase(pkg, registry, testCase)).toEqual({
      name: "compares two city forecasts",
      passed: true,
      failures: [],
    });
  });

  test("normalizes the documented city/state input format deterministically", async () => {
    const process = Bun.spawn(
      [
        "bun",
        "run",
        join(fixture, "scripts", "location-query.ts"),
        "Wilmette, IL",
        "Washington, DC",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();

    expect(await process.exited).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      city_a: "Wilmette",
      city_b: "Washington",
    });
  });
});
