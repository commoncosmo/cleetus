import { expect, it } from "bun:test";
import {
  terminalActivity,
  terminalDirectory,
  terminalProgress,
  terminalProjectTitle,
} from "../../src/ui/windows-terminal";

it("reports running and clears progress only on an interactive Windows Terminal", () => {
  const chunks: string[] = [];
  const output = {
    isTTY: true,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
  };
  terminalProgress("running", output, { WT_SESSION: "test" });
  terminalProgress("clear", output, { WT_SESSION: "test" });
  terminalProgress("running", { ...output, isTTY: false }, { WT_SESSION: "test" });
  terminalProgress("running", output, {});
  terminalProgress("running", output, { WT_SESSION: "test", CLEETUS_TERMINAL_PROGRESS: "0" });
  expect(chunks).toEqual(["\x1b]9;4;3;0\x07", "\x1b]9;4;0;0\x07"]);
});

it("reports project directory and trusted state labels without forwarding control sequences", () => {
  const chunks: string[] = [];
  const output = {
    isTTY: true,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
  };
  const env = { WT_SESSION: "fixture" };
  terminalDirectory("C:\\Projects\\space Ω", output, env);
  terminalActivity("waiting", "C:\\Projects\\space Ω", output, env);
  terminalActivity("running", "C:\\Projects\\space Ω", output, env);
  terminalActivity("clear", "C:\\Projects\\space Ω", output, env);
  expect(chunks).toEqual([
    '\x1b]9;9;"C:\\Projects\\space Ω"\x07',
    "\x1b]9;4;4;0\x07",
    "\x1b]0;Cleetus · space Ω · Needs input\x07",
    "\x1b]9;4;3;0\x07",
    "\x1b]0;Cleetus · space Ω · Working\x07",
    "\x1b]9;4;0;0\x07",
    "\x1b]0;Cleetus · space Ω\x07",
  ]);
  const before = chunks.length;
  for (const path of [
    'C:\\bad"path',
    "C:\\bad\x07path",
    "C:\\bad\u009cpath",
    "/unix/path",
    "relative",
  ])
    terminalDirectory(path, output, env);
  expect(chunks).toHaveLength(before);
  expect(terminalProjectTitle("C:\\repo\x1b]0;injected\x07\n")).toBe("Cleetus · repo");
});

it("redirected/headless output and the integration opt-out emit no metadata", () => {
  const chunks: string[] = [];
  const output = {
    isTTY: true,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
  };
  for (const [target, env] of [
    [{ ...output, isTTY: false }, { WT_SESSION: "test" }],
    [output, {}],
    [output, { WT_SESSION: "test", CLEETUS_TERMINAL_INTEGRATION: "0" }],
  ] as const) {
    terminalActivity("waiting", "C:\\project", target, env);
    terminalDirectory("C:\\project", target, env);
  }
  expect(chunks).toHaveLength(0);
  terminalActivity("running", "C:\\project", output, {
    WT_SESSION: "test",
    CLEETUS_TERMINAL_PROGRESS: "0",
  });
  expect(chunks).toEqual(["\x1b]0;Cleetus · project · Working\x07"]);
});
