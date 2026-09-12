import { describe, expect, it } from "bun:test";
import { CleetusError } from "../../src/lib/errors";
import { VectorStore } from "../../src/vector/store";

const mk = () => new VectorStore(":memory:");

describe("VectorStore", () => {
  it("upserts and queries top-k by similarity", () => {
    const s = mk();
    s.upsert(
      "code",
      [
        { id: "1", text: "alpha" },
        { id: "2", text: "beta" },
      ],
      [new Float32Array([1, 0]), new Float32Array([0, 1])],
      "m1",
    );
    const hits = s.query("code", new Float32Array([1, 0]), 2, "m1");
    expect(hits.map((h) => h.id)).toEqual(["1", "2"]);
    expect(hits[0]!.text).toBe("alpha");
    expect(hits[0]!.score).toBeCloseTo(1, 6);
    s.close();
  });

  it("isolates namespaces", () => {
    const s = mk();
    s.upsert("a", [{ id: "1", text: "x" }], [new Float32Array([1, 0])], "m1");
    s.upsert("b", [{ id: "2", text: "y" }], [new Float32Array([1, 0])], "m1");
    expect(s.query("a", new Float32Array([1, 0]), 10, "m1").map((h) => h.id)).toEqual(["1"]);
    s.close();
  });

  it("upsert is idempotent on (namespace, id)", () => {
    const s = mk();
    s.upsert("a", [{ id: "1", text: "first" }], [new Float32Array([1, 0])], "m1");
    s.upsert("a", [{ id: "1", text: "second" }], [new Float32Array([0, 1])], "m1");
    expect(s.stats("a").count).toBe(1);
    expect(s.query("a", new Float32Array([0, 1]), 1, "m1")[0]!.text).toBe("second");
    s.close();
  });

  it("round-trips metadata", () => {
    const s = mk();
    s.upsert(
      "a",
      [{ id: "1", text: "x", metadata: { path: "f.ts", line: 3 } }],
      [new Float32Array([1, 0])],
      "m1",
    );
    expect(s.query("a", new Float32Array([1, 0]), 1, "m1")[0]!.metadata).toEqual({
      path: "f.ts",
      line: 3,
    });
    s.close();
  });

  it("removes and clears", () => {
    const s = mk();
    s.upsert(
      "a",
      [
        { id: "1", text: "x" },
        { id: "2", text: "y" },
      ],
      [new Float32Array([1, 0]), new Float32Array([0, 1])],
      "m1",
    );
    s.remove("a", ["1"]);
    expect(s.stats("a").count).toBe(1);
    s.clear("a");
    expect(s.stats("a").count).toBe(0);
    expect(s.stats("a").model).toBeUndefined();
    s.close();
  });

  it("throws on embedding model mismatch", () => {
    const s = mk();
    s.upsert("a", [{ id: "1", text: "x" }], [new Float32Array([1, 0])], "m1");
    expect(() => s.query("a", new Float32Array([1, 0]), 1, "m2")).toThrow(CleetusError);
    expect(() => s.upsert("a", [{ id: "2", text: "y" }], [new Float32Array([1, 0])], "m2")).toThrow(
      /re-index/,
    );
    s.close();
  });

  it("throws on dimension mismatch", () => {
    const s = mk();
    s.upsert("a", [{ id: "1", text: "x" }], [new Float32Array([1, 0])], "m1");
    expect(() => s.query("a", new Float32Array([1, 0, 0]), 1, "m1")).toThrow(CleetusError);
    s.close();
  });

  it("throws on dimension mismatch when upserting into an existing namespace", () => {
    const s = mk();
    s.upsert("a", [{ id: "1", text: "x" }], [new Float32Array([1, 0])], "m1");
    expect(() =>
      s.upsert("a", [{ id: "2", text: "y" }], [new Float32Array([1, 0, 0])], "m1"),
    ).toThrow(CleetusError);
    s.close();
  });

  it("reports stats with model and dim", () => {
    const s = mk();
    s.upsert("a", [{ id: "1", text: "x" }], [new Float32Array([1, 0])], "m1");
    expect(s.stats("a")).toEqual({ count: 1, model: "m1", dim: 2 });
    s.close();
  });
});
