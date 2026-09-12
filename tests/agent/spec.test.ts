import { describe, expect, it, test } from "bun:test";
import { transcriptUserInput } from "../../src/agent/runtime";
import { buildSpecTurn, specDatePrefix } from "../../src/agent/spec";
import { stripSystemReminders } from "../../src/skills/compose";

test("specDatePrefix formats a local date zero-padded", () => {
  expect(specDatePrefix(new Date(2026, 6, 3))).toBe("2026-07-03"); // July 3 → month/day padded
});

test("buildSpecTurn embeds the playbook, resolved path, and idea", () => {
  const out = buildSpecTurn({
    playbookBody: "PLAYBOOK_BODY",
    specsDir: "docs/specs",
    datePrefix: "2026-07-13",
    idea: "a retry queue",
    orchestrationAvailable: true,
  });
  expect(out).toContain("PLAYBOOK_BODY");
  expect(out).toContain("docs/specs/2026-07-13-");
  expect(out).toContain("a retry queue");
});

test("buildSpecTurn shows the command as typed and hides the playbook in a system-reminder", () => {
  const out = buildSpecTurn({
    playbookBody: "PLAYBOOK_BODY",
    specsDir: "docs/specs",
    datePrefix: "2026-07-13",
    idea: "a retry queue",
    orchestrationAvailable: true,
  });
  // What the transcript shows (#316): the user's own command, nothing Cleetus injected.
  expect(stripSystemReminders(out)).toBe("/spec a retry queue");
  expect(transcriptUserInput(out)).toBe("/spec a retry queue");
  // What the model still receives: the whole playbook and write-path instruction, inside the block.
  const block = /<system-reminder>([\s\S]*)<\/system-reminder>/.exec(out)?.[1] ?? "";
  expect(block).toContain("PLAYBOOK_BODY");
  expect(block).toContain("docs/specs/2026-07-13-");
  expect(block).toContain("a retry queue");
});

test("buildSpecTurn's visible line is just /spec when no idea is given", () => {
  const out = buildSpecTurn({
    playbookBody: "PB",
    specsDir: "docs/specs",
    datePrefix: "2026-07-13",
    idea: "   ",
    orchestrationAvailable: true,
  });
  expect(transcriptUserInput(out)).toBe("/spec");
});

test("buildSpecTurn normalizes a trailing slash on specsDir", () => {
  const out = buildSpecTurn({
    playbookBody: "PB",
    specsDir: "docs/specs/", // user-edited config with a trailing slash
    datePrefix: "2026-07-13",
    idea: "x",
    orchestrationAvailable: true,
  });
  expect(out).toContain("docs/specs/2026-07-13-");
  expect(out).not.toContain("docs/specs//"); // no doubled slash in the write-path instruction
});

test("buildSpecTurn handles an empty idea with a prompt-the-user note", () => {
  const out = buildSpecTurn({
    playbookBody: "PB",
    specsDir: "docs/specs",
    datePrefix: "2026-07-13",
    idea: "   ",
    orchestrationAvailable: true,
  });
  expect(out).toContain("no initial idea");
  expect(out).not.toContain("rough idea:"); // no dangling idea label when idea is blank
});

const base = {
  playbookBody: "PLAYBOOK",
  specsDir: "docs/specs",
  datePrefix: "2026-07-15",
  idea: "an alt TUI",
};

describe("buildSpecTurn orchestration availability", () => {
  it("adds a note to offer only plan/go when orchestration is unavailable", () => {
    const out = buildSpecTurn({ ...base, orchestrationAvailable: false });
    expect(out.toLowerCase()).toContain("orchestration is currently unavailable");
    expect(out.toLowerCase()).toContain("offer only");
    expect(out).toContain("`plan`");
  });
  it("adds no such note when orchestration is available", () => {
    const out = buildSpecTurn({ ...base, orchestrationAvailable: true });
    expect(out.toLowerCase()).not.toContain("orchestration is currently unavailable");
  });
});
