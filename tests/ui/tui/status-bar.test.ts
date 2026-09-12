import { describe, expect, test } from "bun:test";
import { formatScopeTag } from "../../../src/ui/tui/status-bar";

describe("formatScopeTag", () => {
  test("renders a global tag", () => {
    expect(formatScopeTag("global")).toBe(" · global");
  });
  test("renders a scratch tag", () => {
    expect(formatScopeTag("scratch")).toBe(" · scratch");
  });
  test("empty when no scope", () => {
    expect(formatScopeTag(undefined)).toBe("");
  });
});
