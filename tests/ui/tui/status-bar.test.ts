import { describe, expect, test } from "bun:test";
import { formatSandboxTag, formatScopeTag } from "../../../src/ui/tui/status-bar";

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

describe("formatSandboxTag", () => {
  test("renders the active sandbox as a footer tag", () => {
    expect(formatSandboxTag("Sandbox: Seatbelt")).toBe(" · Sandbox: Seatbelt");
    expect(formatSandboxTag()).toBe("");
  });
});
