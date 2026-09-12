import { describe, expect, it } from "bun:test";
import { renderSkillsHint } from "../../src/skills/prompt";
import type { Skill } from "../../src/skills/types";

const skills: Skill[] = [
  { name: "security-scan", description: "Scan for security issues", source: "built-in", body: "x" },
  { name: "review", description: "Code review", source: "project", body: "y" },
];

describe("renderSkillsHint", () => {
  it("lists each skill name and description", () => {
    const hint = renderSkillsHint(skills);
    expect(hint).toContain("security-scan — Scan for security issues");
    expect(hint).toContain("review — Code review");
  });

  it("tells the model to suggest /skill, not run it itself", () => {
    const hint = renderSkillsHint(skills);
    expect(hint).toContain("/skill");
    expect(hint.toLowerCase()).toContain("suggest");
    expect(hint.toLowerCase()).toContain("do not run a skill yourself");
  });

  it("returns an empty string when there are no skills", () => {
    expect(renderSkillsHint([])).toBe("");
  });

  it("hides the host-only workflow creator from ordinary skill suggestions", () => {
    expect(
      renderSkillsHint([
        ...skills,
        {
          name: "workflow-creator",
          description: "Create workflows",
          source: "built-in",
          body: "host only",
        },
      ]),
    ).not.toContain("workflow-creator");
  });

  it("assembles the full hint with header, one line per skill, and the closing rule", () => {
    expect(renderSkillsHint(skills)).toBe(
      [
        "Available skills (run with /skill <name>):",
        "- security-scan — Scan for security issues",
        "- review — Code review",
        "When the user's request matches a skill, suggest they run the matching `/skill <name>` command. Do not run a skill yourself.",
      ].join("\n"),
    );
  });
});

describe("renderSkillsHint — auto-trigger skills", () => {
  const mixed: Skill[] = [
    {
      name: "tdd",
      description: "TDD",
      source: "built-in",
      body: "b",
      trigger: { when: ["coding-task"], match: [] },
    },
    { name: "review", description: "Code review", source: "project", body: "y" },
  ];

  it("excludes auto-trigger skills from the suggest hint", () => {
    const hint = renderSkillsHint(mixed);
    expect(hint).toContain("review — Code review");
    expect(hint).not.toContain("tdd");
  });

  it("returns an empty string when every skill auto-triggers", () => {
    const allAuto: Skill[] = [
      {
        name: "tdd",
        description: "TDD",
        source: "built-in",
        body: "b",
        trigger: { when: ["coding-task"], match: [] },
      },
    ];
    expect(renderSkillsHint(allAuto)).toBe("");
  });
});
