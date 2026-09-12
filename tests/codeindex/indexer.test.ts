import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Indexer } from "../../src/codeindex/indexer";
import { Manifest } from "../../src/codeindex/manifest";
import type { Provider } from "../../src/providers/types";
import { Embedder } from "../../src/vector/embedder";
import { VectorService } from "../../src/vector/service";

function embedder(model = "m1"): Embedder {
  const provider: Provider = {
    listModels: async () => [],
    chat: async function* () {},
    embed: async (t) => [t.split("\n").length, t.includes("foo") ? 1 : 0],
  };
  return new Embedder(provider, model);
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cleetus-idx-"));
  await $`git init`.cwd(dir).quiet();
  return dir;
}

describe("Indexer", () => {
  it("indexes all tracked files on first run", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.ts"), "const a = 1;\n");
    await writeFile(join(dir, "b.ts"), "const b = 2;\n");
    await $`git add -A`.cwd(dir).quiet();
    const svc = new VectorService({
      projectDbPath: ":memory:",
      globalDbPath: ":memory:",
      embedder: embedder(),
    });
    const indexer = new Indexer({
      projectDir: dir,
      vectorService: svc,
      manifest: new Manifest(":memory:"),
      embedModel: "m1",
    });
    const summary = await indexer.run();
    expect(summary.indexedFiles).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(svc.stats("project", "code").count).toBe(2);
    svc.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("re-embeds only changed files on the second run", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.ts"), "const a = 1;\n");
    await writeFile(join(dir, "b.ts"), "const b = 2;\n");
    await $`git add -A`.cwd(dir).quiet();
    const svc = new VectorService({
      projectDbPath: ":memory:",
      globalDbPath: ":memory:",
      embedder: embedder(),
    });
    const indexer = new Indexer({
      projectDir: dir,
      vectorService: svc,
      manifest: new Manifest(":memory:"),
      embedModel: "m1",
    });
    await indexer.run();
    await writeFile(join(dir, "a.ts"), "const a = 99;\n");
    const summary = await indexer.run();
    expect(summary.indexedFiles).toBe(1);
    expect(summary.skipped).toBe(1);
    svc.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("removes chunks for deleted files", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.ts"), "const a = 1;\n");
    await writeFile(join(dir, "b.ts"), "const b = 2;\n");
    await $`git add -A`.cwd(dir).quiet();
    const svc = new VectorService({
      projectDbPath: ":memory:",
      globalDbPath: ":memory:",
      embedder: embedder(),
    });
    const indexer = new Indexer({
      projectDir: dir,
      vectorService: svc,
      manifest: new Manifest(":memory:"),
      embedModel: "m1",
    });
    await indexer.run();
    await rm(join(dir, "a.ts"));
    await $`git add -A`.cwd(dir).quiet();
    const summary = await indexer.run();
    expect(summary.removed).toBe(1);
    expect(svc.stats("project", "code").count).toBe(1);
    svc.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("rebuilds when the embedding model changed", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.ts"), "const a = 1;\n");
    await $`git add -A`.cwd(dir).quiet();
    const proj = join(dir, "v.db");
    const glob = join(dir, "g.db");
    const man = join(dir, "m.db");
    const svc1 = new VectorService({
      projectDbPath: proj,
      globalDbPath: glob,
      embedder: embedder("m1"),
    });
    const man1 = new Manifest(man);
    await new Indexer({
      projectDir: dir,
      vectorService: svc1,
      manifest: man1,
      embedModel: "m1",
    }).run();
    svc1.close();
    man1.close();
    const svc2 = new VectorService({
      projectDbPath: proj,
      globalDbPath: glob,
      embedder: embedder("m2"),
    });
    const man2 = new Manifest(man);
    const summary = await new Indexer({
      projectDir: dir,
      vectorService: svc2,
      manifest: man2,
      embedModel: "m2",
    }).run();
    expect(summary.rebuilt).toBe(true);
    expect(svc2.stats("project", "code").model).toBe("m2");
    svc2.close();
    man2.close();
    await rm(dir, { recursive: true, force: true });
  });
});
