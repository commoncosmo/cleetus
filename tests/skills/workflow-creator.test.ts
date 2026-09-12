import { describe, expect, test } from "bun:test";
import { BUILTIN_SKILLS } from "../../src/skills/builtins";

describe("workflow-creator built-in skill", () => {
  test("is concise, explicit, and never activates or runs", () => {
    const skill = BUILTIN_SKILLS.find((candidate) => candidate.name === "workflow-creator");
    expect(skill).toBeDefined();
    expect(skill?.description).toContain("explicitly asks");
    expect(skill?.body).toContain("six v1 executors");
    expect(skill?.body).toContain("$steps.fetch.output.body");
    expect(skill?.body).toContain("supports `with.default`");
    expect(skill?.body).toContain("Do not invent host null-coalescing");
    expect(skill?.body).toContain("creator response's `tests`");
    expect(skill?.body).toContain("Never serialize a test into a");
    expect(skill?.body).toContain("first repeated character directly after");
    expect(skill?.body).toContain("not execute packaged scripts");
    expect(skill?.body).toMatch(/does not\s+grant or execute/u);
  });
});
