import { describe, expect, it } from "bun:test";
import {
  composeSkillBody,
  composeSkillTurn,
  renderSkillReminder,
  stripSystemReminders,
} from "../../src/skills/compose";
import type { Skill } from "../../src/skills/types";

const skill: Skill = { name: "scan", description: "d", source: "built-in", body: "PLAYBOOK BODY" };

/** The injected part of a composed turn — what the model sees but the transcript hides. */
const reminderBlock = (out: string): string =>
  /<system-reminder>([\s\S]*)<\/system-reminder>/.exec(out)?.[1] ?? "";

describe("composeSkillTurn", () => {
  it("shows the command as typed and hides the playbook in a system-reminder (#316)", () => {
    const out = composeSkillTurn(skill, "only the diff");
    expect(stripSystemReminders(out)).toBe("/skill scan only the diff");
    expect(reminderBlock(out)).toContain("PLAYBOOK BODY");
    expect(reminderBlock(out)).toContain("User request / arguments: only the diff");
  });

  it("notes inside the reminder when no arguments were provided", () => {
    const out = composeSkillTurn(skill, "   ");
    expect(stripSystemReminders(out)).toBe("/skill scan");
    expect(reminderBlock(out)).toContain("(No additional arguments were provided.)");
  });

  it("appends the base dir and bundled-file listing for a directory skill", () => {
    const dirSkill: Skill = {
      name: "scan",
      description: "d",
      source: "global",
      body: "PLAYBOOK BODY",
      baseDir: "/x/foo",
      resources: ["reference.md", "scripts/run.sh"],
    };
    const out = composeSkillTurn(dirSkill, "go");
    expect(stripSystemReminders(out)).toBe("/skill scan go");
    expect(reminderBlock(out)).toContain(
      "PLAYBOOK BODY\n\n" +
        "Base directory for this skill: /x/foo\n" +
        "Bundled files you can read with read_file as this skill's instructions direct:\n" +
        "- reference.md\n- scripts/run.sh\n\n" +
        "User request / arguments: go",
    );
  });

  it("emits only the base-dir line when a directory skill has no resources", () => {
    const dirSkill: Skill = {
      name: "scan",
      description: "d",
      source: "global",
      body: "BODY",
      baseDir: "/x/bar",
      resources: [],
    };
    const out = composeSkillTurn(dirSkill, "");
    expect(reminderBlock(out)).toContain(
      "BODY\n\nBase directory for this skill: /x/bar\n\n(No additional arguments were provided.)",
    );
  });
});

const flat: Skill = { name: "tdd", description: "d", source: "built-in", body: "Do TDD." };
const dir: Skill = {
  name: "dr",
  description: "d",
  source: "project",
  body: "Read the files.",
  baseDir: "/abs/dr",
  resources: ["a.md", "b.md"],
};

describe("composeSkillBody", () => {
  it("returns the trimmed body with no args trailer", () => {
    expect(composeSkillBody(flat)).toBe("Do TDD.");
  });
  it("includes the directory progressive-disclosure block for dir skills", () => {
    const out = composeSkillBody(dir);
    expect(out).toContain("Base directory for this skill: /abs/dr");
    expect(out).toContain("- a.md");
    expect(out).toContain("- b.md");
    expect(out).not.toContain("User request / arguments");
  });
});

describe("renderSkillReminder", () => {
  it("wraps the body in a system-reminder naming the skill, with no args trailer", () => {
    const out = renderSkillReminder(flat);
    expect(out.startsWith("<system-reminder>")).toBe(true);
    expect(out.endsWith("</system-reminder>")).toBe(true);
    expect(out).toContain('"tdd" skill applies');
    expect(out).toContain("Do TDD.");
    expect(out).not.toContain("No additional arguments");
  });
});

describe("stripSystemReminders", () => {
  it("removes a single trailing block, leaving raw text", () => {
    const t = "do the thing\n\n<system-reminder>\nfollow TDD\n</system-reminder>";
    expect(stripSystemReminders(t)).toBe("do the thing");
  });

  it("removes multiple blocks", () => {
    const t =
      "req\n\n<system-reminder>\nA\n</system-reminder>\n\n<system-reminder>\nB\n</system-reminder>";
    expect(stripSystemReminders(t)).toBe("req");
  });

  it("a block between text preserves both sides", () => {
    const t = "before\n\n<system-reminder>\nX\n</system-reminder>\n\nafter";
    expect(stripSystemReminders(t)).toBe("before\nafter");
  });

  it("text with no block is returned trimmed-unchanged", () => {
    expect(stripSystemReminders("  plain text  ")).toBe("plain text");
  });
});
