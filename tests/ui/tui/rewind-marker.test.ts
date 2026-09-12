import { describe, expect, test } from "bun:test";
import { formatRewindMarker } from "../../../src/ui/tui/rewind-marker";

describe("formatRewindMarker", () => {
  test("single turn, files restored + deleted", () => {
    expect(
      formatRewindMarker({
        userInput: "add a flag",
        revertedTurns: 1,
        filesRestored: 2,
        filesDeleted: 1,
      }),
    ).toBe('↩ reverted to "add a flag" (1 turn, 2 restored, 1 deleted)');
  });

  test("multiple turns, only restores", () => {
    expect(
      formatRewindMarker({
        userInput: "refactor",
        revertedTurns: 3,
        filesRestored: 5,
        filesDeleted: 0,
      }),
    ).toBe('↩ reverted to "refactor" (3 turns, 5 restored)');
  });

  test("no file changes", () => {
    expect(
      formatRewindMarker({
        userInput: "just chatting",
        revertedTurns: 1,
        filesRestored: 0,
        filesDeleted: 0,
      }),
    ).toBe('↩ reverted to "just chatting" (1 turn)');
  });

  test("long input is truncated and whitespace collapsed", () => {
    const out = formatRewindMarker({
      userInput: "  do   a\nvery long thing ".concat("x".repeat(60)),
      revertedTurns: 1,
      filesRestored: 0,
      filesDeleted: 0,
    });
    expect(out).toContain("…");
    expect(out).not.toContain("\n");
  });

  test("appends a todos-cleared note", () => {
    expect(
      formatRewindMarker({
        userInput: "make a list",
        revertedTurns: 1,
        filesRestored: 0,
        filesDeleted: 0,
        todosCleared: true,
      }),
    ).toBe('↩ reverted to "make a list" (1 turn) · todos cleared');
  });

  test("no todos note when todosCleared is false", () => {
    expect(
      formatRewindMarker({
        userInput: "edit",
        revertedTurns: 1,
        filesRestored: 1,
        filesDeleted: 0,
        todosCleared: false,
      }),
    ).toBe('↩ reverted to "edit" (1 turn, 1 restored)');
  });

  test("files not restored note when the snapshot was unavailable", () => {
    expect(
      formatRewindMarker({
        userInput: "broke git",
        revertedTurns: 1,
        filesRestored: 0,
        filesDeleted: 0,
        filesRestoreSkipped: true,
      }),
    ).toBe('↩ reverted to "broke git" (1 turn) · files not restored');
  });

  test("both notes can appear together", () => {
    expect(
      formatRewindMarker({
        userInput: "x",
        revertedTurns: 1,
        filesRestored: 0,
        filesDeleted: 0,
        filesRestoreSkipped: true,
        todosCleared: true,
      }),
    ).toBe('↩ reverted to "x" (1 turn) · files not restored · todos cleared');
  });
});
