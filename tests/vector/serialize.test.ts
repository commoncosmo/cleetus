import { describe, expect, it } from "bun:test";
import { decodeVector, encodeVector } from "../../src/vector/serialize";

describe("vector serialize", () => {
  it("round-trips a Float32Array bit-exact", () => {
    const v = new Float32Array([1.5, -2.25, 0, 256]);
    const back = decodeVector(encodeVector(v));
    expect(Array.from(back)).toEqual(Array.from(v));
  });
  it("preserves length", () => {
    const v = new Float32Array(128).fill(0.5);
    expect(decodeVector(encodeVector(v)).length).toBe(128);
  });
  it("returns an independent buffer (decode does not alias input)", () => {
    const v = new Float32Array([1, 2]);
    const blob = encodeVector(v);
    const back = decodeVector(blob);
    back[0] = 99;
    expect(Array.from(decodeVector(blob))).toEqual([1, 2]);
  });
  it("encode does not alias the source (mutating input leaves blob intact)", () => {
    const v = new Float32Array([1, 2]);
    const blob = encodeVector(v);
    v[0] = 99;
    expect(Array.from(decodeVector(blob))).toEqual([1, 2]);
  });
});
