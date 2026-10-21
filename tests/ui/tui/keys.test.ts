import { describe, expect, it } from "bun:test";
import {
  isClearInputKey,
  isMenuNavigationKey,
  isMenuNextKey,
  isMenuPrevKey,
  isNewlineKey,
  isToggleReasoningKey,
  isToggleTestDetailsKey,
} from "../../../src/ui/tui/keys";

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

describe("isToggleTestDetailsKey", () => {
  it("recognizes Ctrl+E without treating a typed e as a shortcut", () => {
    expect(isToggleTestDetailsKey("e", { ctrl: true })).toBe(true);
    expect(isToggleTestDetailsKey("e", {})).toBe(false);
    expect(isToggleTestDetailsKey("E", { ctrl: true })).toBe(false);
  });
});

describe("isMenuNextKey / isMenuPrevKey", () => {
  it("recognizes Ctrl+N as next and Ctrl+P as previous", () => {
    expect(isMenuNextKey("n", { ctrl: true })).toBe(true);
    expect(isMenuPrevKey("p", { ctrl: true })).toBe(true);
  });

  it("does not treat a typed n or p as a menu chord", () => {
    expect(isMenuNextKey("n", {})).toBe(false);
    expect(isMenuPrevKey("p", {})).toBe(false);
  });

  it("does not cross-match next and previous", () => {
    expect(isMenuNextKey("p", { ctrl: true })).toBe(false);
    expect(isMenuPrevKey("n", { ctrl: true })).toBe(false);
  });

  it("ignores the uppercase forms Ink reports for shift+letter", () => {
    expect(isMenuNextKey("N", { ctrl: true })).toBe(false);
    expect(isMenuPrevKey("P", { ctrl: true })).toBe(false);
  });
});

describe("isMenuNavigationKey", () => {
  it("covers both navigation chords", () => {
    expect(isMenuNavigationKey("n", { ctrl: true })).toBe(true);
    expect(isMenuNavigationKey("p", { ctrl: true })).toBe(true);
  });

  it("leaves every other key alone, including plain n/p and other ctrl chords", () => {
    expect(isMenuNavigationKey("n", {})).toBe(false);
    expect(isMenuNavigationKey("p", {})).toBe(false);
    expect(isMenuNavigationKey("y", { ctrl: true })).toBe(false);
    expect(isMenuNavigationKey("c", { ctrl: true })).toBe(false);
    expect(isMenuNavigationKey("", { return: true })).toBe(false);
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
