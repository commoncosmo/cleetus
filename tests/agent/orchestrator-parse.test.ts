import { expect, test } from "bun:test";
import { parseStructuredPlan, reindex } from "../../src/agent/orchestrator";

const FENCED = [
  "Here is the plan:",
  "```json",
  JSON.stringify({
    brief: "Build a Tauri desk app",
    tasks: [
      { title: "Scaffold", description: "Create the Tauri v2 project", agent_type: "general" },
      { title: "Survey", description: "List the generated files", agent_type: "explore" },
    ],
  }),
  "```",
  "That's the plan.",
].join("\n");

test("parses a fenced json block surrounded by prose", () => {
  const plan = parseStructuredPlan(FENCED, 20);
  expect(plan).not.toBeNull();
  expect(plan!.brief).toBe("Build a Tauri desk app");
  expect(plan!.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  expect(plan!.tasks[0]!.agentType).toBe("general");
  expect(plan!.tasks[1]!.agentType).toBe("explore");
  expect(plan!.tasks[0]!.status).toBe("pending");
});

test("parses a bare json object with no fence", () => {
  const text = JSON.stringify({ tasks: [{ title: "T", description: "D" }] });
  const plan = parseStructuredPlan(text, 20);
  expect(plan!.brief).toBe(""); // brief optional → defaults empty
  expect(plan!.tasks[0]!.agentType).toBe("general"); // agent_type optional → defaults general
});

test("clamps tasks to maxTasks", () => {
  const many = {
    tasks: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, description: "d" })),
  };
  const plan = parseStructuredPlan(JSON.stringify(many), 5);
  expect(plan!.tasks).toHaveLength(5);
});

test("returns null on malformed / empty / non-json", () => {
  expect(parseStructuredPlan("no json here", 20)).toBeNull();
  expect(parseStructuredPlan("```json\n{ not valid }\n```", 20)).toBeNull();
  expect(parseStructuredPlan(JSON.stringify({ tasks: [] }), 20)).toBeNull(); // empty task list
  expect(parseStructuredPlan(JSON.stringify({ tasks: [{ title: "" }] }), 20)).toBeNull(); // invalid task
});

test("parses a fenced plan whose task descriptions contain inner ``` code fences", () => {
  // Real planners (gpt-oss) wrap the plan in a ```json fence AND put shell commands in ```code```
  // fences inside task descriptions. A non-greedy fence match stops at the FIRST inner ```, which
  // truncates the JSON mid-string → parse fails → null. The fence must only anchor where the
  // object starts; a balanced-brace scan then finds the true close. Regression: structuring
  // silently fell back to a single pass for every real coding plan (dbags3/dbags5).
  const text = [
    "```json",
    JSON.stringify({
      brief: "Vite + TS app",
      tasks: [
        {
          title: "Init",
          description: "Run:\n```\nnpm create vite@latest my-app\n```\nthen install the deps.",
          agent_type: "general",
        },
        { title: "Inspect", description: "List the generated files", agent_type: "explore" },
      ],
    }),
    "```",
  ].join("\n");
  const plan = parseStructuredPlan(text, 20);
  expect(plan).not.toBeNull();
  expect(plan!.tasks).toHaveLength(2);
  expect(plan!.tasks[0]!.description).toContain("npm create vite@latest");
  expect(plan!.tasks[1]!.agentType).toBe("explore");
});

test("brace-scan tolerates braces and quotes inside string values", () => {
  // The balanced-brace fallback (no fence) must not terminate on a `}` inside a string value,
  // and must respect escaped quotes — this locks in the scanner's string/escape state machine.
  // (No stray braces precede the JSON, since the scan starts at the first `{`.)
  const real = JSON.stringify({
    brief: 'a quote " and a closing brace } stay inside the string',
    tasks: [{ title: "T", description: "body with } and { inside", agent_type: "general" }],
  });
  const plan = parseStructuredPlan(`Here is the plan: ${real}`, 20);
  expect(plan).not.toBeNull();
  expect(plan!.brief).toContain("closing brace }");
  expect(plan!.tasks[0]!.description).toBe("body with } and { inside");
});

test("reindex renumbers ids from an offset, preserving fields + pending status", () => {
  const plan = parseStructuredPlan(
    JSON.stringify({ tasks: [{ title: "A", description: "a" }] }),
    20,
  )!;
  const re = reindex(plan.tasks, 3);
  expect(re[0]!.id).toBe("t4");
  expect(re[0]!.title).toBe("A");
  expect(re[0]!.status).toBe("pending");
});
