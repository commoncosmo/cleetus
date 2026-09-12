import { describe, expect, it } from "bun:test";
import { cosine, topK } from "../../src/vector/cosine";

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosine(v, new Float32Array([1, 2, 3]))).toBeCloseTo(1, 6);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
  });
  it("returns 0 when either vector is all zeros", () => {
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
  it("throws on dimension mismatch", () => {
    expect(() => cosine(new Float32Array([1]), new Float32Array([1, 2]))).toThrow();
  });
});

describe("topK", () => {
  const cands = [
    { item: "a", embedding: new Float32Array([1, 0]) },
    { item: "b", embedding: new Float32Array([0.9, 0.1]) },
    { item: "c", embedding: new Float32Array([0, 1]) },
  ];
  it("orders by descending similarity", () => {
    const res = topK(new Float32Array([1, 0]), cands, 3);
    expect(res.map((r) => r.item)).toEqual(["a", "b", "c"]);
  });
  it("limits to k", () => {
    expect(topK(new Float32Array([1, 0]), cands, 2)).toHaveLength(2);
  });
  it("handles k larger than candidate count", () => {
    expect(topK(new Float32Array([1, 0]), cands, 99)).toHaveLength(3);
  });
  it("returns empty for empty candidates", () => {
    expect(topK(new Float32Array([1, 0]), [], 5)).toEqual([]);
  });
});
