import { expect, it } from "bun:test";
import { terminalProgress } from "../../src/ui/windows-terminal";

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
