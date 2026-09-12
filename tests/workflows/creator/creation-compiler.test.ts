import { describe, expect, test } from "bun:test";
import { compileWorkflowCreation } from "../../../src/workflows/creator/creation-compiler";
import type { WorkflowCreatorOutput } from "../../../src/workflows/creator/types";
import { parseWorkflowManifest } from "../../../src/workflows/parse";

function creatorOutput(
  manifest: WorkflowCreatorOutput["manifest"],
  resources: WorkflowCreatorOutput["resources"] = [],
): WorkflowCreatorOutput {
  return {
    response: "Drafted.",
    phase: "draft",
    manifest,
    resources,
    assumptions: [],
    unresolvedQuestions: [],
  };
}

describe("workflow creation compiler", () => {
  test("owns identity and canonicalizes model authority, input bindings, and references", () => {
    const manifest = parseWorkflowManifest(`
schema_version: 1
name: model-generated-name
revision: 99
description: Summarize a topic
inputs:
  type: object
  properties:
    topic: { type: string, minLength: 1 }
  required: [topic]
  additionalProperties: false
permissions: {}
execution: { timeout: 5m }
steps:
  - id: summarize
    uses: llm.generate@1
    with:
      prompt: Summarize the topic.
      input:
        topic: { ref: input, path: [topic] }
      output_schema: { type: string }
outputs:
  result:
    value: { ref: step-output, step: summarize, path: [] }
    schema: { type: string }
presentation: { output: result }
`);

    const compiled = compileWorkflowCreation({
      output: creatorOutput(manifest),
      name: "host-name",
      revision: 1,
      request: "Create the workflow.",
    });

    expect(compiled.manifest?.name).toBe("host-name");
    expect(compiled.manifest?.revision).toBe(1);
    expect(compiled.manifest?.permissions.model).toBe(true);
    expect(compiled.authority).toEqual({
      derived: ["model calls"],
      explicit: [],
    });
    expect(compiled.manifest?.steps[0]?.with).toMatchObject({
      input: { topic: "$inputs.topic" },
    });
    expect(compiled.manifest?.outputs.result?.value).toBe("$steps.summarize.output");
  });

  test("accepts an exact packaged script path and derives matching command permission", () => {
    const manifest = parseWorkflowManifest(`
schema_version: 1
name: inventory
revision: 1
description: Run an inventory
inputs: { type: object, properties: {}, additionalProperties: false }
permissions:
  commands:
    - program: bun
      args_prefix: [run, ./scripts/inventory.ts]
execution: { timeout: 5m }
steps:
  - id: inventory
    uses: command.run@1
    with:
      program: bun
      args: [run, ./scripts/inventory.ts]
      output: json
outputs:
  result:
    value: $steps.inventory.output.stdout
    schema: { type: object }
presentation: { output: result }
`);
    const compiled = compileWorkflowCreation({
      output: creatorOutput(manifest, [
        { path: "scripts/inventory.ts", content: "console.log('{}');\n" },
      ]),
      name: "inventory",
      revision: 1,
      request: "Create an inventory.",
      protocol: "blueprint-v1",
    });

    expect(compiled.manifest?.steps[0]?.with).toMatchObject({
      args: ["run", "./scripts/inventory.ts"],
    });
    expect(compiled.manifest?.permissions.commands?.[0]?.args_prefix).toEqual([
      "run",
      "./scripts/inventory.ts",
    ]);
    expect(compiled.compilerNotes).toContain(
      "Offline command tests mock packaged script results and do not execute scripts/inventory.ts; inspect the script and use allow once for its first live run.",
    );
  });

  test("rejects a packaged-script alias instead of guessing its resource", () => {
    const manifest = parseWorkflowManifest(`
schema_version: 1
name: inventory
revision: 1
description: Run an inventory
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: {}
execution: { timeout: 5m }
steps:
  - id: inventory
    uses: command.run@1
    with:
      program: bun
      args: [run, ./scripts/inventory]
      output: json
outputs:
  result:
    value: $steps.inventory.output.stdout
    schema: { type: object }
`);

    expect(() =>
      compileWorkflowCreation({
        output: creatorOutput(manifest, [
          { path: "scripts/inventory.ts", content: "console.log('{}');\n" },
        ]),
        name: "inventory",
        revision: 1,
        request: "Create an inventory.",
      }),
    ).toThrow("packaged script './scripts/inventory' does not match a declared resource");
  });

  test("does not hide a model-authority conflict during normalization", () => {
    const manifest = parseWorkflowManifest(`
schema_version: 1
name: conflict
revision: 1
description: Generate a value
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: { model: false }
execution: { timeout: 5m }
steps:
  - id: generate
    uses: llm.generate@1
    with:
      prompt: Generate one value.
      input: null
      output_schema: { type: string }
outputs:
  result: { value: $steps.generate.output, schema: { type: string } }
`);

    expect(() =>
      compileWorkflowCreation({
        output: creatorOutput(manifest),
        name: "conflict",
        revision: 1,
        request: "Create the workflow.",
      }),
    ).toThrow("declared model authority conflicts with derived model=true");
  });

  test("preserves legacy revision tuning and omitted resources when unrequested", () => {
    const base = parseWorkflowManifest(`
schema_version: 1
name: legacy
revision: 1
description: Generate a result
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: { model: true }
execution: { timeout: 5m }
steps:
  - id: generate
    uses: llm.generate@1
    timeout: 2m
    retry:
      attempts: 1
      backoff: { initial: 1s, multiplier: 2, maximum: 5s }
      when: [timeout]
    with:
      prompt: Original prompt.
      input: null
      output_schema: { type: string }
      provider: original-provider
      model: original-model
      max_output_tokens: 4096
outputs:
  result: { value: $steps.generate.output, schema: { type: string } }
presentation: { output: result }
`);
    const candidate = parseWorkflowManifest(`
schema_version: 1
name: legacy
revision: 2
description: Generate a result
inputs: { type: object, properties: {}, additionalProperties: false }
permissions: { model: true }
execution: { timeout: 5m }
steps:
  - id: generate
    uses: llm.generate@1
    timeout: 10s
    with:
      prompt: Updated prompt.
      input: null
      output_schema: { type: string }
      provider: invented-provider
      model: invented-model
      max_output_tokens: 128
outputs:
  result: { value: $steps.generate.output, schema: { type: string } }
presentation: { output: result }
`);
    const compiled = compileWorkflowCreation({
      output: creatorOutput(candidate),
      name: "legacy",
      revision: 2,
      baseManifest: base,
      baseResources: [{ path: "tests/existing.yaml", content: "{}\n" }],
      request: "Update only the prompt wording.",
    });
    const step = compiled.manifest?.steps[0];

    expect(step?.timeout).toBe("2m");
    expect(step?.retry).toEqual(base.steps[0]?.retry);
    expect(step?.with).toMatchObject({
      prompt: "Updated prompt.",
      provider: "original-provider",
      model: "original-model",
      max_output_tokens: 4096,
    });
    expect(compiled.resources).toEqual([{ path: "tests/existing.yaml", content: "{}\n" }]);
  });

  test("keeps case-specific repair heuristics confined to legacy full-package drafts", () => {
    const manifest = parseWorkflowManifest(`
schema_version: 1
name: strict-blueprint
revision: 7
description: Preserve invalid creator details for diagnostics
inputs: {}
secrets:
  token: { source: env, name: TOKEN }
permissions: {}
execution: { timeout: 5m }
steps:
  - id: generate
    uses: llm.generate@1
    with:
      prompt: Generate a value from topic.
      output_schema: { type: string }
  - id: render
    uses: text.template@1
    with:
      template: "Items\\n{{#each items}}- {{this}}\\n{{/each}}\\n"
      data: { items: [one] }
outputs:
  result:
    value: { ref: step-output, step: render, path: [] }
    schema: { type: string }
presentation: { output: result }
`);

    expect(() =>
      compileWorkflowCreation({
        output: creatorOutput(manifest, [{ path: "tests/legacy.yaml", content: "{}\n" }]),
        name: "strict-blueprint",
        revision: 1,
        request: "Create it.",
        protocol: "blueprint-v1",
      }),
    ).toThrow("structured tests field");

    const compiled = compileWorkflowCreation({
      output: creatorOutput(manifest),
      name: "strict-blueprint",
      revision: 1,
      request: "Create it.",
      protocol: "blueprint-v1",
    });
    expect(compiled.manifest?.inputs).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(compiled.manifest?.steps[0]?.with).not.toHaveProperty("input");
    expect(compiled.manifest?.steps[1]?.with).toMatchObject({
      template: "Items\n{{#each items}}- {{this}}\n{{/each}}\n",
    });

    const explicitlyOpen = compileWorkflowCreation({
      output: creatorOutput({
        ...manifest,
        inputs: { type: "object", additionalProperties: true },
      }),
      name: "strict-blueprint",
      revision: 1,
      request: "Accept a free-form input object.",
      protocol: "blueprint-v1",
    });
    expect(explicitlyOpen.manifest?.inputs).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });
});
