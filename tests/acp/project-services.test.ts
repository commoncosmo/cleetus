import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProjectServiceRegistry } from "../../src/acp/project-services";
import { loadConfig } from "../../src/config/loader";
import { EventLog } from "../../src/events/log";
import { openDatabase } from "../../src/lib/db";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Sandbox } from "../../src/sandbox/types";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AcpProjectServiceRegistry", () => {
  test("caches canonical roots and isolates maps and checkpoints by project", async () => {
    const root = await mkdtemp(join(tmpdir(), "cleetus-acp-projects-"));
    roots.push(root);
    const one = join(root, "one");
    const two = join(root, "two");
    const alias = join(root, "one-alias");
    const globalDir = join(root, "global");
    await Promise.all([mkdir(one), mkdir(two), mkdir(globalDir)]);
    await Promise.all([
      writeFile(join(one, "one.ts"), "export function onlyInOne() { return 1; }\n"),
      writeFile(join(two, "two.ts"), "export function onlyInTwo() { return 2; }\n"),
      symlink(one, alias),
    ]);

    const commands: { command: string; cwd?: string }[] = [];
    const sandbox: Sandbox = {
      async exec(command, opts) {
        commands.push({ command, cwd: opts.cwd });
        return {
          stdout: "",
          stderr: "",
          exitCode: command.includes("rev-parse --is-inside-work-tree") ? 128 : 0,
          timedOut: false,
          cancelled: false,
        };
      },
      async dispose() {},
      writeRoot: () => null,
    };
    const log = new EventLog(join(root, "events.db"));
    const db = openDatabase(join(root, "services.db"));
    const registry = new AcpProjectServiceRegistry({
      loadConfig: (cwd) =>
        loadConfig({ globalPath: join(root, "missing-global.yaml"), projectDir: cwd }),
      sandbox,
      log,
      db,
      globalDir,
      providers: new ProviderRegistry(),
    });

    try {
      const first = await registry.get(one);
      const same = await registry.get(alias);
      const second = await registry.get(two);

      expect(same).toBe(first);
      expect(second).not.toBe(first);
      expect(first.repoMap).toContain("onlyInOne");
      expect(first.repoMap).not.toContain("onlyInTwo");
      expect(second.repoMap).toContain("onlyInTwo");
      expect(second.repoMap).not.toContain("onlyInOne");

      await first.checkpoints?.begin("shared-session-id", "one turn", 0);
      await second.checkpoints?.begin("shared-session-id", "two turn", 0);
      expect(first.checkpoints?.list("shared-session-id").map((item) => item.userInput)).toEqual([
        "one turn",
      ]);
      expect(second.checkpoints?.list("shared-session-id").map((item) => item.userInput)).toEqual([
        "two turn",
      ]);

      expect(
        commands.filter((call) => call.command.includes("rev-parse --is-inside-work-tree")),
      ).toHaveLength(2);
      expect(new Set(commands.map((call) => call.cwd))).toEqual(new Set([first.cwd, second.cwd]));
    } finally {
      registry.dispose();
      db.close();
      log.close();
    }
  });
});
