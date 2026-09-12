import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INK_FULL_CLEAR_MARK,
  containsInkFullClear,
  createRenderDebugSink,
  estimateWrappedLines,
  formatRenderDebugLine,
  renderDebugEnabled,
} from "../../../src/ui/tui/render-debug";

describe("renderDebugEnabled", () => {
  it("is off by default (env var unset)", () => {
    expect(renderDebugEnabled({})).toBe(false);
  });
  it("is off when the var is empty string", () => {
    expect(renderDebugEnabled({ CLEETUS_RENDER_DEBUG: "" })).toBe(false);
  });
  it("is on when the var is set to any non-empty value", () => {
    expect(renderDebugEnabled({ CLEETUS_RENDER_DEBUG: "1" })).toBe(true);
  });
});

describe("containsInkFullClear", () => {
  it("detects Ink's full-screen-clear signature (the erase-scrollback escape)", () => {
    // ink.js:121 writes ansiEscapes.clearTerminal = \x1b[2J\x1b[3J\x1b[H on a full clear.
    const frame = `${INK_FULL_CLEAR_MARK}some static output\nplus dynamic`;
    expect(containsInkFullClear(frame)).toBe(true);
    // The exact clearTerminal string embedded mid-frame is also caught.
    expect(containsInkFullClear("\u001B[2J\u001B[3J\u001B[Hbody")).toBe(true);
  });
  it("does not fire on ordinary differential frames (eraseLines, no scrollback clear)", () => {
    // A normal Ink diff frame uses eraseLines (\x1b[NF ... \x1b[J), never \x1b[3J.
    expect(containsInkFullClear("\u001B[2K\u001B[1Ghello\u001B[J")).toBe(false);
    expect(containsInkFullClear("plain text, no escapes")).toBe(false);
  });
});

describe("estimateWrappedLines", () => {
  it("counts one line per short segment", () => {
    expect(estimateWrappedLines("hello", 80)).toBe(1);
  });
  it("counts a blank line for each newline-delimited empty segment", () => {
    expect(estimateWrappedLines("a\n\nb", 80)).toBe(3);
  });
  it("wraps a long segment by the width", () => {
    expect(estimateWrappedLines("x".repeat(200), 80)).toBe(3); // ceil(200/80)
  });
  it("sums wrapped lines across segments", () => {
    expect(estimateWrappedLines(`${"x".repeat(80)}\n${"y".repeat(81)}`, 80)).toBe(3); // 1 + 2
  });
  it("treats a non-positive width defensively as width 1 (never divides by zero)", () => {
    expect(estimateWrappedLines("ab", 0)).toBe(2);
  });
});

describe("formatRenderDebugLine", () => {
  it("serializes a full_clear record as a single JSON line", () => {
    const line = formatRenderDebugLine({ kind: "full_clear", ts: 5, rows: 24, bytes: 900, seq: 2 });
    expect(line).toBe('{"kind":"full_clear","ts":5,"rows":24,"bytes":900,"seq":2}');
    expect(line).not.toContain("\n");
  });
  it("serializes a commit record with the row height vs viewport", () => {
    const rec = {
      kind: "commit" as const,
      ts: 7,
      termRows: 24,
      rowType: "assistant_message",
      textLen: 1400,
      estLines: 30,
      eventId: "abc",
    };
    expect(JSON.parse(formatRenderDebugLine(rec))).toEqual(rec);
  });
});

describe("createRenderDebugSink", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "render-debug-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSONL line per record when enabled", () => {
    const path = join(dir, "render-debug.jsonl");
    const sink = createRenderDebugSink(path, true);
    sink.log({ kind: "full_clear", ts: 1, rows: 24, bytes: 100, seq: 0 });
    sink.log({
      kind: "commit",
      ts: 2,
      termRows: 24,
      rowType: "assistant_message",
      textLen: 50,
      estLines: 30,
      eventId: "e1",
    });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe("full_clear");
    expect(JSON.parse(lines[1]!).estLines).toBe(30);
  });

  it("is a no-op that writes no file when disabled", () => {
    const path = join(dir, "render-debug.jsonl");
    const sink = createRenderDebugSink(path, false);
    sink.log({ kind: "full_clear", ts: 1, rows: 24, bytes: 100, seq: 0 });
    expect(existsSync(path)).toBe(false);
  });
});
