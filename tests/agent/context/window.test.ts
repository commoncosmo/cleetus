import { expect, test } from "bun:test";
import {
  computeRecentBoundary,
  liveTurnStart,
  messageTokens,
  protectFreshestToolResult,
  sumTokens,
} from "../../../src/agent/context/window";
import type { Message } from "../../../src/providers/types";

const _u = (c: string): Message => ({ role: "user", content: c });
const _a = (c: string): Message => ({ role: "assistant", content: c });
const _tool = (c: string): Message => ({ role: "tool", toolCallId: "x", content: c });

test("liveTurnStart finds the last user message", () => {
  expect(liveTurnStart([_u("first"), _a("reply"), _u("second"), _a("working")])).toBe(2);
});

test("liveTurnStart returns 0 when no user message", () => {
  expect(liveTurnStart([_a("only")])).toBe(0);
});

test("messageTokens and sumTokens count content + tool calls", () => {
  const m: Message = {
    role: "assistant",
    content: "x".repeat(40),
    toolCalls: [{ id: "1", name: "bash", args: { command: "ls" } }],
  };
  expect(messageTokens(m)).toBeGreaterThan(10);
  expect(sumTokens([m, _u("y".repeat(40))], 0, 2)).toBe(messageTokens(m) + 10);
});

test("computeRecentBoundary keeps the whole history when it fits", () => {
  const h = [_a("x".repeat(40)), _u("live"), _a("reply")];
  expect(computeRecentBoundary(h, 10_000)).toBe(0);
});

test("computeRecentBoundary backfills newest-first and can land inside the live turn", () => {
  const big = "x".repeat(40); // ~10 tokens each (ceil(len/4))
  const h = [_u("task"), _a(big), _a(big), _a(big), _a(big)];
  // target 25 tokens fits the 2 newest (20) but not 3 (30); boundary lands at index 3
  expect(computeRecentBoundary(h, 25)).toBe(3);
});

test("computeRecentBoundary always keeps at least the newest message, even if oversized", () => {
  const h = [_a("x".repeat(40)), _a("x".repeat(4000))]; // last msg ~1000 tokens >> target
  expect(computeRecentBoundary(h, 5)).toBe(1);
});

test("computeRecentBoundary never starts the tail on an orphaned tool result", () => {
  const h = [_a("parent"), _tool("result")];
  const b = computeRecentBoundary(h, 1);
  expect(h[b]?.role).not.toBe("tool");
});

test("computeRecentBoundary returns history.length for empty history", () => {
  expect(computeRecentBoundary([], 100)).toBe(0);
});

test("protectFreshestToolResult returns boundary unchanged when there is no tool result", () => {
  const h: Message[] = [_u("q"), _a("reply")];
  expect(protectFreshestToolResult(h, 2)).toBe(2);
});

test("protectFreshestToolResult clamps to the assistant parent of the freshest tool result", () => {
  // 0:user 1:assistant(tool-call) 2:tool 3:assistant(tool-call) 4:tool  — freshest group is 3,4.
  const h: Message[] = [_u("q"), _a("call1"), _tool("r1"), _a("call2"), _tool("r2")];
  expect(protectFreshestToolResult(h, 4)).toBe(3); // keep parent@3 and result@4 in the tail
});

test("protectFreshestToolResult keeps all siblings of a parallel tool-call group", () => {
  // 0:user 1:assistant 2:tool 3:tool 4:tool  — one parent@1, three parallel results.
  const h: Message[] = [_u("q"), _a("parallel"), _tool("a"), _tool("b"), _tool("c")];
  expect(protectFreshestToolResult(h, 4)).toBe(1); // clamp to the single parent, keep 2,3,4
});

test("protectFreshestToolResult never moves the boundary forward", () => {
  const h: Message[] = [_u("q"), _a("call"), _tool("r")];
  expect(protectFreshestToolResult(h, 1)).toBe(1); // boundary already at/before parent → unchanged
});
