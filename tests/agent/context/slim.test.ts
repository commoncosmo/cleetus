import { expect, test } from "bun:test";
import { slimDeepHistory } from "../../../src/agent/context/slim";
import type { Message } from "../../../src/providers/types";

const tool = (c: string): Message => ({ role: "tool", toolCallId: "x", content: c });

test("truncates oversized tool results before the live turn", () => {
  // tail = history.slice(boundaryIndex); here boundaryIndex=0, liveStart=1 (global index)
  const tail: Message[] = [tool("y".repeat(5000)), { role: "user", content: "live" }];
  const out = slimDeepHistory(tail, 1, 0, 2000, 12000);
  expect(out[0]!.content.length).toBeLessThan(2100);
  expect(out[0]!.content).toContain("[truncated");
  expect(out[1]!.content).toBe("live"); // live turn untouched
});

test("leaves short tool results and non-tool messages intact", () => {
  const tail: Message[] = [
    tool("short"),
    { role: "assistant", content: "z".repeat(5000) },
    { role: "user", content: "live" },
  ];
  const out = slimDeepHistory(tail, 2, 0, 2000, 12000);
  expect(out[0]!.content).toBe("short");
  expect(out[1]!.content.length).toBe(5000); // assistant prose not slimmed
});

test("does not slim tool results at or after the live turn", () => {
  // a tool message INSIDE the live turn (global index >= liveStart) stays full
  const tail: Message[] = [
    { role: "user", content: "live" }, // global index 0 = liveStart
    tool("y".repeat(5000)),
  ];
  const out = slimDeepHistory(tail, 0, 0, 2000, 12000);
  expect(out[1]!.content.length).toBe(5000);
});

test("is deterministic — same input yields identical output bytes", () => {
  const tail: Message[] = [tool("y".repeat(5000)), { role: "user", content: "live" }];
  const a = slimDeepHistory(tail, 1, 0, 2000, 12000);
  const b = slimDeepHistory(tail, 1, 0, 2000, 12000);
  expect(a[0]!.content).toBe(b[0]!.content);
});

test("does not mutate the input messages", () => {
  const original = tool("y".repeat(5000));
  const tail = [original, { role: "user", content: "live" } as Message];
  slimDeepHistory(tail, 1, 0, 2000, 12000);
  expect(original.content.length).toBe(5000);
});

test("respects a nonzero boundaryIndex when computing global position", () => {
  // tail starts at global index 3; liveStart at global 4. tail[0] is global 3 (< liveStart) → slim.
  const tail: Message[] = [tool("y".repeat(5000)), { role: "user", content: "live" }];
  const out = slimDeepHistory(tail, 4, 3, 2000, 12000);
  expect(out[0]!.content).toContain("[truncated");
});

test("caps oversized live tool results with the actionable live marker", () => {
  // tail = [user@0 (liveStart 0), tool(20000)@1] — the tool is inside the live turn.
  const tail: Message[] = [{ role: "user", content: "live" }, tool("y".repeat(20000))];
  const out = slimDeepHistory(tail, 0, 0, 2000, 12000);
  expect(out[1]!.content.length).toBeLessThan(12100);
  expect(out[1]!.content).toContain("request a narrower range");
  expect(out[1]!.content).toContain("truncated 8000 chars"); // 20000 - 12000
});

test("leaves live tool results under the live cap untouched (by reference)", () => {
  const original = tool("y".repeat(5000));
  const tail: Message[] = [{ role: "user", content: "live" }, original];
  const out = slimDeepHistory(tail, 0, 0, 2000, 12000);
  expect(out[1]).toBe(original); // same reference — not copied, not truncated
});

test("applies the deep cap to pre-live results and the live cap to live results together", () => {
  // global 0 = deep tool (before liveStart 1); global 2 = live tool.
  const tail: Message[] = [
    tool("d".repeat(20000)), // global 0, deep
    { role: "user", content: "live" }, // global 1 = liveStart
    tool("l".repeat(20000)), // global 2, live
  ];
  const out = slimDeepHistory(tail, 1, 0, 2000, 12000);
  expect(out[0]!.content).toContain("older tool output"); // deep marker
  expect(out[0]!.content.length).toBeLessThan(2100);
  expect(out[2]!.content).toContain("request a narrower range"); // live marker
  expect(out[2]!.content.length).toBeLessThan(12100);
});

test("capToolResult via slimDeepHistory: oversized result keeps head AND tail", () => {
  const body = `HEAD-MARKER\n${"x".repeat(20000)}\nERROR: the real failure`;
  const tail: Message[] = [{ role: "tool", content: body, toolCallId: "t1" }];
  const out = slimDeepHistory(tail, 0, 0, 2000, 12000);
  const slimmed = out[0]!.content;
  expect(slimmed.length).toBeLessThan(body.length);
  expect(slimmed.startsWith("HEAD-MARKER")).toBe(true);
  expect(slimmed).toContain("ERROR: the real failure");
  expect(slimmed).toContain("truncated");
});

test("slimDeepHistory: under-cap results are returned by reference, unchanged", () => {
  const tail: Message[] = [{ role: "tool", content: "short", toolCallId: "t1" }];
  const out = slimDeepHistory(tail, 0, 0, 2000, 12000);
  expect(out[0]).toBe(tail[0]);
});
