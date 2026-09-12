import { describe, expect, it } from "bun:test";
import { diffLines } from "../../../src/ui/diff/lcs";

const txt = (ops: { op: string; text: string }[], drop: string) =>
  ops
    .filter((o) => o.op !== drop)
    .map((o) => o.text)
    .join("\n");

describe("diffLines", () => {
  it("marks identical input as all eq", () => {
    const ops = diffLines("a\nb\nc", "a\nb\nc");
    expect(ops.every((o) => o.op === "eq")).toBe(true);
    expect(ops.map((o) => o.text)).toEqual(["a", "b", "c"]);
  });

  it("handles a pure insertion", () => {
    const ops = diffLines("a\nc", "a\nb\nc");
    expect(ops).toContainEqual({ op: "add", text: "b" });
    expect(ops.filter((o) => o.op === "del")).toHaveLength(0);
  });

  it("handles a pure deletion", () => {
    const ops = diffLines("a\nb\nc", "a\nc");
    expect(ops).toContainEqual({ op: "del", text: "b" });
    expect(ops.filter((o) => o.op === "add")).toHaveLength(0);
  });

  it("represents a replacement as del then add", () => {
    const ops = diffLines("a\nb\nc", "a\nB\nc");
    expect(ops).toContainEqual({ op: "del", text: "b" });
    expect(ops).toContainEqual({ op: "add", text: "B" });
  });

  it("treats empty before as all additions", () => {
    const ops = diffLines("", "x\ny");
    expect(ops.some((o) => o.op === "add" && o.text === "x")).toBe(true);
  });

  it("reconstructs both sides (drop adds → before, drop dels → after)", () => {
    const before = "one\ntwo\nthree\nfour";
    const after = "one\n2\nthree\nfour\nfive";
    const ops = diffLines(before, after);
    expect(txt(ops, "add")).toBe(before);
    expect(txt(ops, "del")).toBe(after);
  });
});
