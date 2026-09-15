import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../helpers/trusted-config";

async function withConfig(
  files: { global?: string; project?: string },
  fn: (cfg: Awaited<ReturnType<typeof loadConfig>>) => void | Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "cleetus-effort-cfg-"));
  const globalPath = join(dir, "global.yaml");
  if (files.global !== undefined) await writeFile(globalPath, files.global);
  if (files.project !== undefined) {
    await mkdir(join(dir, ".cleetus"), { recursive: true });
    await writeFile(join(dir, ".cleetus", "config.yaml"), files.project);
  }
  try {
    await fn(await loadConfig({ globalPath, projectDir: dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("default_effort config", () => {
  it("defaults to medium when unset", async () => {
    await withConfig({}, (cfg) => {
      expect(cfg.defaultEffort).toBe("medium");
    });
  });

  it("reads default_effort from config", async () => {
    await withConfig({ global: "default_effort: high\n" }, (cfg) => {
      expect(cfg.defaultEffort).toBe("high");
    });
  });

  it("accepts the extended xhigh level", async () => {
    await withConfig({ global: "default_effort: xhigh\n" }, (cfg) => {
      expect(cfg.defaultEffort).toBe("xhigh");
    });
  });

  it("lets project override global", async () => {
    await withConfig(
      { global: "default_effort: high\n", project: "default_effort: low\n" },
      (cfg) => {
        expect(cfg.defaultEffort).toBe("low");
      },
    );
  });
});
