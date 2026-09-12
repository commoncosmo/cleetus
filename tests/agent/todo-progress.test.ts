import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  explicitPlanFiles,
  missingExpectedFiles,
  missingVerificationEvidence,
  observedTodoPhaseTransition,
  seededTodoContract,
  todoTransitionSatisfied,
} from "../../src/agent/todo-progress";
import type { TodoItem } from "../../src/tools/types";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const TODOS: TodoItem[] = [
  { content: "— Scaffolding", status: "in_progress" },
  { content: "— Config Module (`src/config.ts`)", status: "pending" },
  { content: "— Ollama Module (`src/ollama.ts`)", status: "pending" },
  { content: "— CLI Entry Point (`src/cli.ts`)", status: "pending" },
  { content: "— Full Suite Verification", status: "pending" },
];

describe("seeded todo contract", () => {
  const plan = `# Plan
## Step 5 — Full Suite Verification
Run \`bun test\` and \`tsc --noEmit\`.

**Smoke test:** launch the CLI once.

## File Summary
| File | Purpose |
|---|---|
| \`package.json\` | metadata |
| \`.env.example\` | template |
| \`src/cli.ts\` | entry |
`;

  it("extracts only explicit file-summary deliverables", () => {
    expect(explicitPlanFiles(plan)).toEqual(["package.json", ".env.example", "src/cli.ts"]);
  });

  it("derives the named final verification evidence", () => {
    expect(seededTodoContract(plan)).toEqual({
      expectedFiles: ["package.json", ".env.example", "src/cli.ts"],
      verification: ["test", "quality", "launch"],
    });
  });

  it("recognizes a plain final numbered Verification step and Summary of Files heading", () => {
    const commonPlan = `# Plan
#### 4. Implement the CLI
#### 5. Verification
Run \`bun test\` and launch the CLI.

### Summary of Files & What They Do
| File | Purpose |
|---|---|
| \`src/index.ts\` | entry point |
`;
    expect(seededTodoContract(commonPlan)).toEqual({
      expectedFiles: ["src/index.ts"],
      verification: ["test", "launch"],
    });
  });

  it("reports only evidence that has not successfully completed", () => {
    expect(
      missingVerificationEvidence(seededTodoContract(plan).verification, [
        {
          key: "bash:bun test",
          command: "bun test",
          ok: true,
          detail: "6 pass",
          evidence: "test",
          scope: "full",
        },
        {
          key: "smoke_run:bun src/cli.ts",
          command: "bun src/cli.ts",
          ok: false,
          detail: "connection refused",
          evidence: "launch",
        },
      ]),
    ).toEqual(["quality", "launch"]);
  });

  it("carries UI render evidence separately from build and launch evidence", () => {
    const uiPlan = `
## Steps
1. Implement the user interface dialog.
2. Verify the rendered layout in a browser.

## Final verification
Run \`bun test\`, \`bun run build\`, and a smoke run.
`;
    const contract = seededTodoContract(uiPlan);
    expect(contract.verification).toEqual(["test", "quality", "launch", "render"]);
    expect(
      missingVerificationEvidence(contract.verification, [
        {
          key: "bash:bun test",
          command: "bun test",
          ok: true,
          detail: "pass",
          evidence: "test",
          scope: "full",
        },
        {
          key: "bash:bun run build",
          command: "bun run build",
          ok: true,
          detail: "pass",
          evidence: "quality",
        },
        {
          key: "smoke_run:bun run dev",
          command: "bun run dev",
          ok: true,
          detail: "ready",
          evidence: "launch",
        },
      ]),
    ).toEqual(["render"]);
  });

  it("accepts an explicitly promised empty file as present", async () => {
    const root = join(
      process.env.TMPDIR ?? "/tmp",
      `cleetus-todo-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tempRoots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".env.example"), "");
    expect(await missingExpectedFiles([".env.example", "src/cli.ts"], root)).toEqual([
      "src/cli.ts",
    ]);
  });
});

describe("observed todo phase transitions", () => {
  it("recognizes a later task's explicit path without claiming completion", () => {
    expect(
      observedTodoPhaseTransition({
        todos: TODOS,
        tool: "write_file",
        args: { path: "src/config.test.ts" },
        diffPath: "/tmp/project/src/config.test.ts",
      }),
    ).toEqual({ from: 0, to: 1 });
  });

  it("recognizes the final verification phase only for a full verifier", () => {
    const cliActive = TODOS.map((todo, index) => ({
      ...todo,
      status:
        index < 3 ? ("completed" as const) : index === 3 ? ("in_progress" as const) : todo.status,
    }));
    expect(
      observedTodoPhaseTransition({
        todos: cliActive,
        tool: "bash",
        args: { command: "bun test" },
        fullVerification: true,
      }),
    ).toEqual({ from: 3, to: 4 });
    expect(
      observedTodoPhaseTransition({
        todos: cliActive,
        tool: "bash",
        args: { command: "bun test src/cli.test.ts" },
        fullVerification: false,
      }),
    ).toBeNull();
  });

  it("does not jump across pending implementation steps into final verification", () => {
    expect(
      observedTodoPhaseTransition({
        todos: TODOS,
        tool: "bash",
        args: { command: "bun test" },
        fullVerification: true,
      }),
    ).toBeNull();
  });

  it("accepts a punctuation-normalized update that moves the target out of pending", () => {
    expect(
      todoTransitionSatisfied(TODOS, 1, [
        { content: "Scaffolding", status: "completed" },
        { content: "- Config Module (src/config.ts)", status: "in_progress" },
        ...TODOS.slice(2),
      ]),
    ).toBe(true);
    expect(todoTransitionSatisfied(TODOS, 1, TODOS)).toBe(false);
  });

  it("accepts an honest forward reconciliation even when it differs from the inferred target", () => {
    expect(
      todoTransitionSatisfied(TODOS, 4, [
        { content: "Scaffolding", status: "completed" },
        { content: "Config Module (`src/config.ts`)", status: "in_progress" },
        ...TODOS.slice(2),
      ]),
    ).toBe(true);
  });
});
