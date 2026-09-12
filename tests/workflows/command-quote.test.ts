import { describe, expect, test } from "bun:test";
import { quoteWorkflowArg, quoteWorkflowCommand } from "../../src/workflows/command-quote";

describe("workflow command quoting", () => {
  test("quotes every argv element and makes metacharacters inert", () => {
    expect(quoteWorkflowCommand("printf", ["%s", "a b", "$(touch /tmp/no)", "it's", "\n"])).toBe(
      "'printf' '%s' 'a b' '$(touch /tmp/no)' 'it'\\''s' '\n'",
    );
    expect(quoteWorkflowArg("")).toBe("''");
  });
});
