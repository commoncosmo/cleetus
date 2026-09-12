import { describe, expect, test } from "bun:test";
import { deriveWorkflowCreationPermissions } from "../../../src/workflows/creator/creation-permissions";
import { parseWorkflowManifest } from "../../../src/workflows/parse";

function manifest(permissions: string, steps: string) {
  return parseWorkflowManifest(`
schema_version: 1
name: authority
revision: 1
description: Exercise derived authority
inputs:
  type: object
  properties:
    host: { type: string }
    program: { type: string }
  additionalProperties: false
permissions: ${permissions}
execution: { timeout: 5m }
steps:
${steps}
outputs:
  result: { value: true, schema: { type: boolean } }
`);
}

describe("workflow creation permissions", () => {
  test("derives HTTP, exact command, and model authority while preserving explicit filesystem", () => {
    const result = deriveWorkflowCreationPermissions(
      manifest(
        `
  filesystem:
    read: [$project/data/**]
    write: [$project/reports/**]
`,
        `  - id: fetch
    uses: http.request@1
    with: { url: https://API.EXAMPLE.test/items, method: get }
  - id: run
    uses: command.run@1
    with:
      program: bun
      args: [run, ./scripts/report.ts]
      output: json
  - id: summarize
    uses: llm.generate@1
    with:
      prompt: Summarize.
      input: $steps.run.output.stdout
      output_schema: { type: string }
`,
      ),
    );

    expect(result.permissions).toEqual({
      network: [{ host: "api.example.test", methods: ["GET"] }],
      commands: [
        {
          program: "bun",
          args_prefix: ["run", "./scripts/report.ts"],
        },
      ],
      filesystem: {
        read: ["$project/data/**"],
        write: ["$project/reports/**"],
      },
      model: true,
    });
    expect(result.authority).toEqual({
      derived: [
        "command bun run ./scripts/report.ts",
        "model calls",
        "network GET api.example.test",
      ],
      explicit: ["read $project/data/**", "write $project/reports/**"],
    });
  });

  test("accepts exact duplicated derived authority and labels only additional authority explicit", () => {
    const result = deriveWorkflowCreationPermissions(
      manifest(
        `
  network:
    - { host: api.example.test, methods: [GET] }
    - { host: redirects.example.test, methods: [GET] }
  commands:
    - { program: bun, args_prefix: [run, ./scripts/report.ts] }
    - { program: git, args_prefix: [status, --short] }
`,
        `  - id: fetch
    uses: http.request@1
    with: { url: https://api.example.test/items }
  - id: run
    uses: command.run@1
    with:
      program: bun
      args: [run, ./scripts/report.ts]
      output: json
`,
      ),
    );

    expect(result.authority.derived).toEqual([
      "command bun run ./scripts/report.ts",
      "network GET api.example.test",
    ]);
    expect(result.authority.explicit).toEqual([
      "command git status --short",
      "network GET redirects.example.test",
    ]);
  });

  test("rejects declared authority that would require silent widening", () => {
    expect(() =>
      deriveWorkflowCreationPermissions(
        manifest(
          `
  network:
    - { host: wrong.example.test, methods: [GET] }
`,
          `  - id: fetch
    uses: http.request@1
    with: { url: https://api.example.test/items }
`,
        ),
      ),
    ).toThrow("declared network authority conflicts with derived GET api.example.test");

    expect(() =>
      deriveWorkflowCreationPermissions(
        manifest(
          `
  commands:
    - { program: bun }
`,
          `  - id: run
    uses: command.run@1
    with:
      program: bun
      args: [run, ./scripts/report.ts]
      output: json
`,
        ),
      ),
    ).toThrow("declared command authority conflicts with derived bun run ./scripts/report.ts");

    expect(() =>
      deriveWorkflowCreationPermissions(
        manifest(
          "{ model: false }",
          `  - id: summarize
    uses: llm.generate@1
    with:
      prompt: Summarize.
      input: null
      output_schema: { type: string }
`,
        ),
      ),
    ).toThrow("declared model authority conflicts with derived model=true");
  });

  test("fails closed when HTTP or command authority is dynamic", () => {
    expect(() =>
      deriveWorkflowCreationPermissions(
        manifest(
          "{}",
          `  - id: fetch
    uses: http.request@1
    with: { url: "https://\${inputs.host}/items" }
`,
        ),
      ),
    ).toThrow("HTTP host cannot contain a runtime reference");

    expect(() =>
      deriveWorkflowCreationPermissions(
        manifest(
          "{}",
          `  - id: run
    uses: command.run@1
    with:
      program: $inputs.program
      output: text
`,
        ),
      ),
    ).toThrow("command program must be static");
  });
});
