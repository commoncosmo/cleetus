import { describe, expect, test } from "bun:test";
import { parseEditorWords } from "../../src/editor/words";

describe("parseEditorWords", () => {
  test("parses whitespace, quotes, empty arguments, and escapes without invoking a shell", () => {
    expect(
      parseEditorWords(`code --wait "two words" 'literal $HOME' "" path\\ name`, "value"),
    ).toEqual(["code", "--wait", "two words", "literal $HOME", "", "path name"]);
  });

  test("rejects incomplete quoting and escaping", () => {
    expect(() => parseEditorWords(`vim "unfinished`, "$EDITOR")).toThrow(
      'contains an unterminated " quote',
    );
    expect(() => parseEditorWords("vim \\", "$EDITOR")).toThrow("ends with an incomplete escape");
  });
});
