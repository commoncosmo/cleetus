import { describe, expect, test } from "bun:test";
import { capOutput } from "../../../src/tools/git/shared";

describe("capOutput", () => {
  test("returns short output unchanged by reference", () => {
    const s = "hello";
    expect(capOutput(s)).toBe(s);
  });

  test("keeps head and tail with an elision marker naming the byte count", () => {
    const head = "H".repeat(60_000);
    const middle = "M".repeat(200_000);
    const tail = "T".repeat(60_000);
    const out = capOutput(head + middle + tail);
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
    expect(out).toContain("bytes elided …]");
    expect(out).toMatch(/\[… \d+ bytes elided …\]/);
    // Tail dominates (75%): more T's survive than H's.
    expect((out.match(/T/g) ?? []).length).toBeGreaterThan((out.match(/H/g) ?? []).length);
    // Total kept stays within the cap plus the marker line.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(210_000);
  });

  test("multi-byte content at the cut points does not garble the interior", () => {
    // Leading "a" shifts parity so é sequences start at odd byte offsets: the head cut at
    // byte 50,000 lands MID-sequence (a real split), while the tail cut at byte offset
    // total-150,000 = 150,001 lands ON a sequence start (clean). Verified empirically.
    const s = `a${"é".repeat(150_000)}`; // 1 + 300,000 bytes
    const out = capOutput(s);
    const [h, t] = out.split(/\n\[… \d+ bytes elided …\]\n/);
    // Head: interior clean — "a" then an unbroken run of é's; the lossy replacement char
    // appears only AT the cut boundary (last char), never inside.
    expect(h!.startsWith("a")).toBe(true);
    expect(h!.endsWith("é�")).toBe(true);
    expect(/^é+$/.test(h!.slice(1, -1))).toBe(true);
    // Tail: cut fell on a sequence boundary → entirely clean, no replacement char anywhere.
    expect(/^é+$/.test(t!)).toBe(true);
  });
});
