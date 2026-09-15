import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../helpers/trusted-config";

describe("loadConfig embeddings", () => {
  it("parses and normalizes the embeddings block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-cfg-"));
    await mkdir(join(dir, ".cleetus"), { recursive: true });
    await writeFile(
      join(dir, ".cleetus", "config.yaml"),
      "embeddings:\n  provider: ollama\n  model: nomic-embed-text\n",
    );
    const cfg = await loadConfig({ globalPath: join(dir, "nope.yaml"), projectDir: dir });
    expect(cfg.embeddings).toEqual({ provider: "ollama", model: "nomic-embed-text" });
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves embeddings undefined when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-cfg-"));
    const cfg = await loadConfig({ globalPath: join(dir, "nope.yaml"), projectDir: dir });
    expect(cfg.embeddings).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});
