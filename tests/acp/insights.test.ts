import { expect, test } from "bun:test";
import { runAcpInsights } from "../../src/acp/insights";
import type { EventSource } from "../../src/events/log";
import type { Event } from "../../src/events/types";

function event(sessionId: string, type: Event["type"], payload: unknown, ts: number): Event {
  return { id: `${sessionId}-${ts}`, sessionId, type, payload, ts };
}

const source: EventSource = {
  listSessions: () => ["one", "two"],
  query: (sessionId) => [
    event(sessionId, "user_input", { text: `request ${sessionId}` }, 100),
    event(sessionId, "assistant_message", { text: "done" }, 101),
  ],
};

test("ACP insights stays scoped to the addressed session", async () => {
  const output = await runAcpInsights({ source, sessionId: "one", args: "" });
  expect(output).toContain("Insights — 1 turns across 1 session(s)");
  expect(output).not.toContain("2 turns");
});

test("ACP insights validates since durations and handles an empty filtered session", async () => {
  expect(await runAcpInsights({ source, sessionId: "one", args: "since yesterday" })).toBe(
    "invalid 'since' value 'yesterday' (use e.g. 7d, 24h, 30m)",
  );
  expect(
    await runAcpInsights({
      source,
      sessionId: "one",
      args: "since 1h",
      now: () => 4_000_000,
    }),
  ).toBe("no turns found for session 'one'");
});
