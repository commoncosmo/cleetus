import { expect, it } from "bun:test";
import { destructiveCommandDecision } from "../../src/tools/destructive-command";

it("applies the destructive project guard to common PowerShell removal commands", () => {
  for (const command of [
    "Remove-Item -Recurse -Force .git",
    "ri -Recurse .cleetus",
    "Remove-Item -Recurse src",
    "Remove-Item -Recurse .",
  ]) {
    expect(
      destructiveCommandDecision({ command, projectDir: process.cwd(), projectAlreadyExists: true })
        .blocked,
    ).toBe(true);
  }
});
