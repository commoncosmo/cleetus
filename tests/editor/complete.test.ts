import { describe, expect, test } from "bun:test";
import { completeEditorLine } from "../../src/editor/complete";
import { buildSkillRegistry } from "../../src/skills/registry";
import type { Skill } from "../../src/skills/types";

const skills: Skill[] = [
  {
    name: "built-in-review",
    description: "Embedded",
    source: "built-in",
    body: "",
  },
  {
    name: "security-review",
    description: "Project security review",
    source: "project",
    body: "",
    filePath: "/project/.cleetus/skills/security-review/SKILL.md",
  },
];

const sources = {
  workflows: () => [
    { name: "weather-fetch", source: "project" as const },
    { name: "weekly-brief", source: "global" as const },
  ],
  skills: buildSkillRegistry([], skills),
  artifacts: (kind: "spec" | "plan") =>
    kind === "spec"
      ? ["docs/specs/editor-security.md", "docs/specs/workflows.md"]
      : [".cleetus/plans/editor.md"],
};

describe("completeEditorLine", () => {
  test("completes the explicit outside-project option without discovering paths", () => {
    expect(completeEditorLine(sources, "/edit ").map((item) => item.value)).toEqual([
      "/edit --create ",
      "/edit --outside-project ",
    ]);
    expect(completeEditorLine(sources, "/edit --c").map((item) => item.value)).toEqual([
      "/edit --create ",
    ]);
    expect(completeEditorLine(sources, "/edit README")).toEqual([]);
  });

  test("completes workflow edit, active names, and explicit scope flags", () => {
    expect(completeEditorLine(sources, "/workflow e")).toEqual([
      {
        display: "edit — open an isolated manual workflow revision",
        value: "/workflow edit ",
        fillOnly: true,
      },
    ]);
    expect(completeEditorLine(sources, "/workflow edit brief").map((item) => item.value)).toEqual([
      "/workflow edit weekly-brief ",
    ]);
    expect(
      completeEditorLine(sources, "/workflow edit weekly-brief --p").map((item) => item.value),
    ).toEqual(["/workflow edit weekly-brief --project"]);
  });

  test("offers only user-authored skills after skill edit", () => {
    expect(completeEditorLine(sources, "/skill edit ").map((item) => item.value)).toEqual([
      "/skill edit security-review",
    ]);
  });

  test("completes editor scopes", () => {
    expect(completeEditorLine(sources, "/config edit ").map((item) => item.value)).toEqual([
      "/config edit global",
      "/config edit project",
    ]);
    expect(completeEditorLine(sources, "/instructions edit c").map((item) => item.value)).toEqual([
      "/instructions edit cleetus",
    ]);
  });

  test("completes known project-relative artifact paths", () => {
    expect(completeEditorLine(sources, "/spec edit work").map((item) => item.value)).toEqual([
      "/spec edit docs/specs/workflows.md",
    ]);
    expect(completeEditorLine(sources, "/plan edit ").map((item) => item.value)).toEqual([
      "/plan edit .cleetus/plans/editor.md",
    ]);
  });

  test("does not complete multiline or unrelated input", () => {
    expect(completeEditorLine(sources, "/workflow edit\nweather")).toEqual([]);
    expect(completeEditorLine(sources, "workflow edit ")).toEqual([]);
  });
});
