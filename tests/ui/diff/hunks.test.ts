import { describe, expect, it } from "bun:test";
import { toHunks } from "../../../src/ui/diff/hunks";
import type { DiffOp } from "../../../src/ui/diff/lcs";

const eq = (t: string): DiffOp => ({ op: "eq", text: t });
const add = (t: string): DiffOp => ({ op: "add", text: t });
const del = (t: string): DiffOp => ({ op: "del", text: t });

describe("toHunks", () => {
  it("returns no hunks for all-eq input", () => {
    const r = toHunks([eq("a"), eq("b"), eq("c")]);
    expect(r.hunks).toHaveLength(0);
    expect(r.truncated).toBe(0);
  });

  it("keeps context lines around a single change and drops the rest", () => {
    const ops = [
      eq("1"),
      eq("2"),
      eq("3"),
      eq("4"),
      eq("5"),
      del("6"),
      add("6b"),
      eq("7"),
      eq("8"),
      eq("9"),
      eq("10"),
    ];
    const r = toHunks(ops, 2);
    expect(r.hunks).toHaveLength(1);
    const texts = r.hunks[0]!.ops.map((o) => o.text);
    expect(texts).toEqual(["4", "5", "6", "6b", "7", "8"]);
  });

  it("merges two changes within 2*context into one hunk", () => {
    const ops = [del("a"), eq("1"), eq("2"), del("b")];
    const r = toHunks(ops, 2);
    expect(r.hunks).toHaveLength(1);
  });

  it("splits two far-apart changes into separate hunks", () => {
    const ops = [del("a"), eq("1"), eq("2"), eq("3"), eq("4"), eq("5"), eq("6"), del("b")];
    const r = toHunks(ops, 1);
    expect(r.hunks).toHaveLength(2);
  });

  it("caps total emitted lines and reports the remainder", () => {
    const ops: DiffOp[] = [];
    for (let i = 0; i < 50; i++) ops.push(add(`+${i}`));
    const r = toHunks(ops, 3, 20);
    const emitted = r.hunks.reduce((acc, h) => acc + h.ops.length, 0);
    expect(emitted).toBeLessThanOrEqual(20);
    expect(r.truncated).toBe(50 - emitted);
  });
});
