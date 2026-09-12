import { describe, expect, it } from "bun:test";
import { Manifest } from "../../src/codeindex/manifest";

const mk = () => new Manifest(":memory:");

describe("Manifest", () => {
  it("set/get round-trips an entry", () => {
    const m = mk();
    m.set("a.ts", { hash: "h1", chunkCount: 3 });
    expect(m.get("a.ts")).toEqual({ hash: "h1", chunkCount: 3 });
    expect(m.get("missing.ts")).toBeUndefined();
    m.close();
  });

  it("set upserts on path", () => {
    const m = mk();
    m.set("a.ts", { hash: "h1", chunkCount: 3 });
    m.set("a.ts", { hash: "h2", chunkCount: 5 });
    expect(m.get("a.ts")).toEqual({ hash: "h2", chunkCount: 5 });
    expect(m.allPaths()).toEqual(["a.ts"]);
    m.close();
  });

  it("delete and clear remove entries", () => {
    const m = mk();
    m.set("a.ts", { hash: "h", chunkCount: 1 });
    m.set("b.ts", { hash: "h", chunkCount: 1 });
    m.delete("a.ts");
    expect(m.allPaths()).toEqual(["b.ts"]);
    m.clear();
    expect(m.allPaths()).toEqual([]);
    m.close();
  });
});
