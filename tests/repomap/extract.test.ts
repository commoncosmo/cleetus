import { describe, expect, it } from "bun:test";
import { extractSymbols } from "../../src/repomap/extract";

describe("extractSymbols — TS/JS", () => {
  it("extracts exported and top-level declarations with 1-based line numbers", () => {
    const src = [
      "import { x } from './x';", // 1
      "export function alpha() {}", // 2
      "export async function beta() {}", // 3
      "export class Gamma {}", // 4
      "export const delta = 5;", // 5
      "export interface Eps {}", // 6
      "export type Zeta = string;", // 7
      "function eta() {}", // 8
      "class Theta {}", // 9
    ].join("\n");
    expect(extractSymbols("f.ts", src)).toEqual([
      { name: "alpha", kind: "function", line: 2 },
      { name: "beta", kind: "function", line: 3 },
      { name: "Gamma", kind: "class", line: 4 },
      { name: "delta", kind: "const", line: 5 },
      { name: "Eps", kind: "interface", line: 6 },
      { name: "Zeta", kind: "type", line: 7 },
      { name: "eta", kind: "function", line: 8 },
      { name: "Theta", kind: "class", line: 9 },
    ]);
  });

  it("ignores indented (non-top-level) declarations like class methods", () => {
    const src = ["class A {", "  method() {}", "  function nested() {}", "}"].join("\n");
    expect(extractSymbols("a.ts", src)).toEqual([{ name: "A", kind: "class", line: 1 }]);
  });

  it("names a nameless default export 'default'", () => {
    expect(extractSymbols("d.ts", "export default function () {}")).toEqual([
      { name: "default", kind: "function", line: 1 },
    ]);
  });

  it("captures a named default class export", () => {
    expect(extractSymbols("c.ts", "export default class Widget {}")).toEqual([
      { name: "Widget", kind: "class", line: 1 },
    ]);
  });

  it("names a nameless default class export 'default'", () => {
    expect(extractSymbols("c.ts", "export default class {}")).toEqual([
      { name: "default", kind: "class", line: 1 },
    ]);
  });

  it("handles .mjs and .cjs extensions", () => {
    expect(extractSymbols("util.mjs", "export function x() {}")).toEqual([
      { name: "x", kind: "function", line: 1 },
    ]);
    expect(extractSymbols("legacy.cjs", "export const y = 1;")).toEqual([
      { name: "y", kind: "const", line: 1 },
    ]);
  });

  it("returns [] for unknown extensions", () => {
    expect(extractSymbols("readme.md", "# Title\nexport function nope() {}")).toEqual([]);
  });
});

describe("extractSymbols — Python", () => {
  it("extracts column-0 def/class only", () => {
    const src = [
      "def top():",
      "    def nested():",
      "        pass",
      "class C:",
      "    def m(self):",
    ].join("\n");
    expect(extractSymbols("m.py", src)).toEqual([
      { name: "top", kind: "function", line: 1 },
      { name: "C", kind: "class", line: 4 },
    ]);
  });
});

describe("extractSymbols — Go", () => {
  it("extracts func (incl. methods with receivers), struct, interface", () => {
    const src = [
      "func Plain() {}",
      "func (r *T) Method() {}",
      "type User struct {",
      "type Reader interface {",
    ].join("\n");
    expect(extractSymbols("g.go", src)).toEqual([
      { name: "Plain", kind: "function", line: 1 },
      { name: "Method", kind: "function", line: 2 },
      { name: "User", kind: "struct", line: 3 },
      { name: "Reader", kind: "interface", line: 4 },
    ]);
  });
});
