import { expect, test } from "bun:test";
import {
  buildCommandRule,
  commandPatternMatches,
  commandRuleMatches,
  commandShellIdentity,
  suggestedCommandPattern,
  validCommandPattern,
} from "../../src/permission/command-pattern";
import { evaluateRules } from "../../src/permission/evaluator";
import { buildGrantRule } from "../../src/ui/tui/permission-grant";

const context = {
  command: "bun test tests/a.test.ts --timeout 30000",
  cwd: process.cwd(),
  shell: "bash:/bin/bash",
};

test("command patterns match argument boundaries and wildcards anywhere", () => {
  expect(commandPatternMatches("rg * src", "rg needle src")).toBe(true);
  expect(commandPatternMatches("Get-Content *", "Get-Content README.md")).toBe(true);
  expect(commandPatternMatches("bun test tests/*.test.ts --timeout 30000", context.command)).toBe(
    true,
  );
  expect(commandPatternMatches("bun test * --timeout 30000", "bun test a b --timeout 30000")).toBe(
    true,
  );
  expect(commandPatternMatches("bun test * --timeout 30000", "bun test --timeout 30000")).toBe(
    true,
  );
  expect(commandPatternMatches("bun test *", "bun testing a")).toBe(false);
  expect(commandPatternMatches("bun test tests/*.ts", "bun test tests/a.ts other.ts")).toBe(false);
  expect(commandPatternMatches("bun test * --timeout 30000", "bun test a --timeout 40000")).toBe(
    false,
  );
  expect(commandPatternMatches('bun test "tests/a file.ts"', "bun test 'tests/a file.ts'")).toBe(
    true,
  );
  expect(commandPatternMatches("bun test tests/*", "  bun   test   tests/a.ts  ")).toBe(true);
  expect(commandPatternMatches("bun test tests/*", "bun test Tests/a.ts")).toBe(false);
  expect(commandPatternMatches('git diff "C:\\Work\\*.ts"', 'git diff "C:\\Work\\a.ts"')).toBe(
    true,
  );
});

test("shell expressions never match reusable command rules", () => {
  for (const command of [
    "bun test a; rm -rf x",
    "bun test a && other",
    "bun test a | other",
    "bun test a > out",
    "bun test a\nother",
    "bun test $(other)",
    "bun test `other`",
    "bun test $env:TOKEN",
    "bun test %TOKEN%",
    "bun test @('x')",
    "bun test a # comment",
    "bun test 'a;other'",
    "bun test a\r",
    "bun test a\u2028other",
    "bun test a\u2029other",
    "bun test a\u0085other",
    'bun test "unterminated',
    "bun test a\\ b",
    "bun test x\u0000",
  ])
    expect(commandPatternMatches("bun test *", command)).toBe(false);
  for (const pattern of [
    "* test *",
    "bun *",
    "bun te*t *",
    "pwsh -Command *",
    "pwsh.exe. -Command *",
    "bash -c *",
    "node -e *",
    "env bun *",
    "bun test *; other",
  ])
    expect(validCommandPattern(pattern)).toBe(false);
  expect(suggestedCommandPattern("bun test a && other")).toBeNull();
  expect(suggestedCommandPattern("bun test tests/a.ts")).toBe("bun test *");
});

test("shell identity unifies PATH selection with an explicit path to the same shell", async () => {
  const name = process.platform === "win32" ? "pwsh.exe" : "bash";
  const executable = Bun.which(name);
  if (!executable) return;
  const sandbox = {
    shell: process.platform === "win32" ? ("powershell" as const) : ("bash" as const),
    exec: async () => {
      throw new Error("unused");
    },
    dispose: async () => {},
    writeRoot: () => null,
  };
  expect(await commandShellIdentity({ ...sandbox, shellExecutable: async () => name })).toBe(
    await commandShellIdentity({ ...sandbox, shellExecutable: async () => executable }),
  );
});

test("scoped command rules bind cwd and shell and require raw command context", () => {
  const rule = { ...buildCommandRule("bun test *", context)!, decision: "allow" as const };
  expect(commandRuleMatches(rule, context)).toBe(true);
  expect(commandRuleMatches(rule, { ...context, cwd: `${context.cwd}/other` })).toBe(false);
  expect(commandRuleMatches(rule, { ...context, shell: "powershell:pwsh.exe" })).toBe(false);
  expect(commandRuleMatches(rule)).toBe(false);
  const rules = { project: [rule], global: [] };
  expect(evaluateRules(rules, "bash", "misleading display", undefined, undefined, context)).toBe(
    "allow",
  );
  expect(evaluateRules(rules, "bash", context.command)).toBeNull();
  expect(evaluateRules(rules, "other", context.command, undefined, undefined, context)).toBeNull();
  expect(
    evaluateRules(
      { project: [rule, { tool: "bash", argsPattern: "bun test*", decision: "deny" }], global: [] },
      "bash",
      context.command,
      undefined,
      undefined,
      context,
    ),
  ).toBe("deny");
});

test("CLI editing uses the raw pending command and never silently adds a wildcard", () => {
  expect(buildGrantRule("bash", "bun test tests/*.test.ts --timeout 30000", context)).toEqual({
    tool: "bash",
    commandPattern: "bun test tests/*.test.ts --timeout 30000",
    commandCwd: context.cwd,
    commandShell: context.shell,
  });
  expect(buildGrantRule("bash", "bun test", context)).toBeNull();
  expect(buildGrantRule("bash", "bun test *; other", context)).toBeNull();
  expect(buildGrantRule("bash", context.command, context)?.commandPattern).toBe(context.command);
});
