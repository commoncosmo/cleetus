import { describe, expect, test } from "bun:test";
import { runGh, runGit } from "../../src/git/run";
import { recordingSandbox } from "./helpers";

const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };

describe("runGit", () => {
  test("prepends `git`, quotes args, runs in projectDir", async () => {
    const { sandbox, calls } = recordingSandbox({ exitCode: 0, stdout: "ok" });
    const r = await runGit(sandbox, ["commit", "-m", "a b"], ctx);
    expect(calls[0]!.command).toBe("git commit -m 'a b'");
    expect(calls[0]!.opts.cwd).toBe("/proj");
    expect(calls[0]!.opts.signal).toBe(ctx.abortSignal);
    expect(r).toMatchObject({ exitCode: 0, stdout: "ok" });
  });

  test("path arguments after -- are quoted individually", async () => {
    const { sandbox, calls } = recordingSandbox({});
    await runGit(sandbox, ["add", "--", "a file.ts", "b.ts"], ctx);
    expect(calls[0]!.command).toBe("git add -- 'a file.ts' b.ts");
  });

  test("passes through stderr / exit code / kill flags", async () => {
    const { sandbox } = recordingSandbox({ exitCode: 1, stderr: "boom", cancelled: true });
    const r = await runGit(sandbox, ["status"], ctx);
    expect(r).toMatchObject({ exitCode: 1, stderr: "boom", cancelled: true });
  });
});

describe("runGh", () => {
  test("prepends `gh` and quotes the body", async () => {
    const { sandbox, calls } = recordingSandbox({});
    await runGh(sandbox, ["pr", "create", "--body", "multi\nline"], ctx);
    expect(calls[0]!.command).toBe("gh pr create --body 'multi\nline'");
  });
});
