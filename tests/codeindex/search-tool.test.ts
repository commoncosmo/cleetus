import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeSearchTool } from "../../src/codeindex/search-tool";
import type { Provider } from "../../src/providers/types";
import { Embedder } from "../../src/vector/embedder";
import { VectorService } from "../../src/vector/service";

function provider(): Provider {
  return {
    listModels: async () => [],
    chat: async function* () {},
    embed: async (t) => [t.includes("cat") ? 1 : 0, t.includes("rust") ? 1 : 0],
  };
}
const embedder = (model: string) => new Embedder(provider(), model);
const svcWith = (e: Embedder | null) =>
  new VectorService({ projectDbPath: ":memory:", globalDbPath: ":memory:", embedder: e });

const ctx = () => ({ projectDir: "/tmp", abortSignal: new AbortController().signal });

describe("CodeSearchTool", () => {
  it("reports disabled when embeddings not configured", async () => {
    const res = await new CodeSearchTool(svcWith(null)).run({ query: "x" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("config.yaml");
  });

  it("reports an empty index", async () => {
    const res = await new CodeSearchTool(svcWith(embedder("m1"))).run({ query: "x" }, ctx());
    expect(res.output).toContain("run /index");
  });

  it("formats hits as path:lines (score) + text", async () => {
    const svc = svcWith(embedder("m1"));
    await svc.index("project", "code", [
      {
        id: "cat.ts#0",
        text: "a cat naps",
        metadata: { path: "cat.ts", startLine: 1, endLine: 1 },
      },
      {
        id: "rust.ts#0",
        text: "rust memory",
        metadata: { path: "rust.ts", startLine: 5, endLine: 6 },
      },
    ]);
    const res = await new CodeSearchTool(svc).run({ query: "cat", k: 1 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("cat.ts:1-1");
    expect(res.output).toContain("a cat naps");
    expect(res.output).not.toContain("rust.ts");
    svc.close();
  });

  it("tells the user to re-index on model mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-cs-"));
    const proj = join(dir, "v.db");
    const glob = join(dir, "g.db");
    const svc1 = new VectorService({
      projectDbPath: proj,
      globalDbPath: glob,
      embedder: embedder("m1"),
    });
    await svc1.index("project", "code", [
      { id: "a#0", text: "x", metadata: { path: "a", startLine: 1, endLine: 1 } },
    ]);
    svc1.close();
    const svc2 = new VectorService({
      projectDbPath: proj,
      globalDbPath: glob,
      embedder: embedder("m2"),
    });
    const res = await new CodeSearchTool(svc2).run({ query: "x" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("run /index to rebuild");
    svc2.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves the vector index from the active tool-context project", async () => {
    const one = svcWith(embedder("m1"));
    const two = svcWith(null);
    await one.index("project", "code", [
      {
        id: "one.ts#0",
        text: "project one",
        metadata: { path: "one.ts", startLine: 1, endLine: 1 },
      },
    ]);
    const tool = new CodeSearchTool((projectDir) => (projectDir === "/one" ? one : two));
    try {
      const first = await tool.run(
        { query: "project" },
        { projectDir: "/one", abortSignal: new AbortController().signal },
      );
      const second = await tool.run(
        { query: "project" },
        { projectDir: "/two", abortSignal: new AbortController().signal },
      );
      expect(first.output).toContain("one.ts:1-1");
      expect(second.output).toContain("code search unavailable");
    } finally {
      one.close();
      two.close();
    }
  });
});
