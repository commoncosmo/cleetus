import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "../../../src/sandbox/types";
import { resolved } from "../../../src/workflows/provenance";
import { createCommandRunStep } from "../../../src/workflows/steps/command-run";

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "workflow-command-"));
  const packageDir = join(workspace, ".cleetus", "workflows", "test");
  mkdirSync(join(packageDir, "scripts"), { recursive: true });
  writeFileSync(join(packageDir, "scripts", "normalize.ts"), "console.log('{}')");
  return { workspace, packageDir };
}

function sandboxWith(result: Partial<Awaited<ReturnType<Sandbox["exec"]>>> = {}): {
  sandbox: Sandbox;
  calls: Array<{ command: string; options: unknown }>;
} {
  const calls: Array<{ command: string; options: unknown }> = [];
  return {
    calls,
    sandbox: {
      async exec(command, options) {
        calls.push({ command, options });
        return {
          stdout: '{"ok":true}',
          stderr: "",
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          ...result,
        };
      },
      async dispose() {},
      writeRoot: () => null,
    },
  };
}

describe("command.run@1", () => {
  test("passes inert argv, stdin, cwd, and a minimal environment to the sandbox", async () => {
    const { workspace, packageDir } = fixture();
    const fake = sandboxWith();
    const step = createCommandRunStep({ sandbox: fake.sandbox, packageDir });
    const output = await step.execute(
      resolved({
        program: "printf",
        args: ["%s", "$(touch /tmp/no)", "a\nb"],
        stdin: "input",
        output: "json",
        env: { MODE: "strict" },
      }),
      {
        signal: new AbortController().signal,
        runId: "run",
        workspace,
      },
    );
    expect(fake.calls[0]?.command).toBe("'printf' '%s' '$(touch /tmp/no)' 'a\nb'");
    expect(fake.calls[0]?.options).toMatchObject({
      cwd: workspace,
      stdin: "input",
      env: { MODE: "strict" },
    });
    expect(output.value).toMatchObject({ stdout: { ok: true }, exit_code: 0 });
    expect(output.provenance.untrusted).toBe(true);
  });

  test("resolves packaged scripts and requires bun run", async () => {
    const { workspace, packageDir } = fixture();
    const fake = sandboxWith();
    const step = createCommandRunStep({ sandbox: fake.sandbox, packageDir });
    await step.execute(
      resolved({
        program: "bun",
        args: ["run", "./scripts/normalize.ts"],
        output: "json",
      }),
      {
        signal: new AbortController().signal,
        runId: "run",
        workspace,
      },
    );
    expect(fake.calls[0]?.command).toContain("'bun' 'run'");
    expect(fake.calls[0]?.command).toContain("/scripts/normalize.ts");
    await expect(
      step.execute(
        resolved({
          program: "node",
          args: ["./scripts/normalize.ts"],
          output: "json",
        }),
        {
          signal: new AbortController().signal,
          runId: "run",
          workspace,
        },
      ),
    ).rejects.toThrow("bun run");
  });

  test("rejects path escapes, output overflow, nonzero exits, and malformed JSON", async () => {
    const { workspace, packageDir } = fixture();
    const escaped = createCommandRunStep({
      sandbox: sandboxWith().sandbox,
      packageDir,
    });
    await expect(
      escaped.execute(
        resolved({
          program: "pwd",
          output: "text",
          cwd: "..",
        }),
        {
          signal: new AbortController().signal,
          runId: "run",
          workspace,
        },
      ),
    ).rejects.toThrow("escapes");

    for (const [result, message] of [
      [{ stdout: "too large", stderr: "", max: 1 }, "exceeds"],
      [{ stdout: "", stderr: "no", exitCode: 2 }, "exited with code 2"],
      [{ stdout: "not-json" }, "not valid JSON"],
    ] as const) {
      const fakeResult = { ...result };
      const max = "max" in fakeResult ? fakeResult.max : undefined;
      const step = createCommandRunStep({
        sandbox: sandboxWith(fakeResult).sandbox,
        packageDir,
      });
      await expect(
        step.execute(
          resolved({
            program: "command",
            output: "json",
            ...(max ? { max_output_bytes: max } : {}),
          }),
          {
            signal: new AbortController().signal,
            runId: "run",
            workspace,
          },
        ),
      ).rejects.toThrow(message);
    }
  });
});
