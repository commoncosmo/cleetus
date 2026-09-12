import { describe, expect, it } from "bun:test";
import { isClearInputKey, isNewlineKey, isToggleReasoningKey } from "../../../src/ui/tui/keys";

describe("isClearInputKey", () => {
  it("recognizes Ctrl+C without treating a typed c as clear", () => {
    expect(isClearInputKey("c", { ctrl: true })).toBe(true);
    expect(isClearInputKey("c", {})).toBe(false);
    expect(isClearInputKey("x", { ctrl: true })).toBe(false);
  });
});

describe("isToggleReasoningKey", () => {
  it("recognizes Ctrl+R without treating a typed r as a shortcut", () => {
    expect(isToggleReasoningKey("r", { ctrl: true })).toBe(true);
    expect(isToggleReasoningKey("r", {})).toBe(false);
    expect(isToggleReasoningKey("R", { ctrl: true })).toBe(false);
  });
});

describe("isNewlineKey", () => {
  it("treats plain Enter as submit, not newline", () => {
    expect(isNewlineKey("\r", { return: true })).toBe(false);
  });

  it("treats Option+Enter (ESC+CR: '\\r' with no return flag) as a newline", () => {
    expect(isNewlineKey("\r", {})).toBe(true);
  });

  it("treats Shift+Enter on modifyOtherKeys terminals as a newline", () => {
    expect(isNewlineKey("[27;2;13~", {})).toBe(true);
  });

  it("treats a reported shift/meta+Enter as a newline", () => {
    expect(isNewlineKey("\r", { return: true, shift: true })).toBe(true);
    expect(isNewlineKey("\r", { return: true, meta: true })).toBe(true);
  });

  it("does not treat a normal character as a newline", () => {
    expect(isNewlineKey("a", {})).toBe(false);
  });
});
