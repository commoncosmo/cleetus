import { expect, test } from "bun:test";
import {
  detectVersionPin,
  versionPinReminder,
  versionPinReminderFor,
} from "../../src/agent/version-pin";

test("detects a v-prefixed version pin", () => {
  expect(detectVersionPin("build a Tauri v2 desktop app")).toBe("Tauri v2");
  expect(detectVersionPin("use Vue v3 here")).toBe("Vue v3");
});

test("detects a bare-integer and 'version N' pin", () => {
  expect(detectVersionPin("scaffold a React 19 project")).toBe("React 19");
  expect(detectVersionPin("Next.js version 14 app")).toBe("Next.js version 14");
});

test("returns null when there is no framework+version pin", () => {
  expect(detectVersionPin("build a todo app")).toBeNull();
  expect(detectVersionPin("add 3 buttons")).toBeNull();
  expect(detectVersionPin("build 3 widgets")).toBeNull();
});

test("versionPinReminder names the phrase and uses the system-reminder framing", () => {
  const r = versionPinReminder("Tauri v2");
  expect(r).toContain("Tauri v2");
  expect(r).toContain("<system-reminder>");
  expect(r).toContain("web_fetch");
});

test("versionPinReminderFor gates on coding-task AND web tools enabled", () => {
  expect(versionPinReminderFor("build a Tauri v2 app", true, true)).not.toBeNull();
  expect(versionPinReminderFor("build a Tauri v2 app", true, true)!.pin).toBe("Tauri v2");
  expect(versionPinReminderFor("build a Tauri v2 app", false, true)).toBeNull(); // not a coding task
  expect(versionPinReminderFor("build a Tauri v2 app", true, false)).toBeNull(); // web off
  expect(versionPinReminderFor("build a todo app", true, true)).toBeNull(); // no pin
});
