import { describe, expect, it } from "bun:test";
import { deriveStopReason, eventToUpdate, isCapStop, toolKind } from "../../src/acp/event-bridge";

function ev(type: string, payload: unknown) {
  return { id: "e", ts: 0, sessionId: "s1", type, payload } as const;
}

describe("eventToUpdate", () => {
  it("maps a model chunk to agent_message_chunk", () => {
    expect(eventToUpdate(ev("model_call_chunk", { text: "hi" }))).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
    });
  });

  it("maps a reasoning chunk to agent_thought_chunk", () => {
    expect(eventToUpdate(ev("reasoning_chunk", { text: "think" }))).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "think" },
    });
  });

  it("maps tool_call_start to a tool_call with mapped kind and in_progress status", () => {
    const u = eventToUpdate(
      ev("tool_call_start", { id: "t1", tool: "write_file", summary: "write a.ts" }),
    ) as {
      sessionUpdate: string;
      toolCallId: string;
      kind: string;
      status: string;
    };
    expect(u.sessionUpdate).toBe("tool_call");
    expect(u.toolCallId).toBe("t1");
    expect(u.kind).toBe("edit");
    expect(u.status).toBe("in_progress");
  });

  it("maps tool_call_end to a completed/failed tool_call_update", () => {
    const ok = eventToUpdate(ev("tool_call_end", { id: "t1", ok: true, output: "done" })) as {
      status: string;
    };
    expect(ok.status).toBe("completed");
    const bad = eventToUpdate(ev("tool_call_end", { id: "t1", ok: false, output: "boom" })) as {
      status: string;
    };
    expect(bad.status).toBe("failed");
  });

  it("returns null for events with no ACP analog", () => {
    expect(eventToUpdate(ev("compaction_start", {}))).toBeNull();
  });

  it("suppresses verbose-only notices unless verbose output is enabled", () => {
    const diagnostic = ev("notice", {
      text: "discarded internal correction",
      visibility: "verbose",
    });
    expect(eventToUpdate(diagnostic)).toBeNull();
    expect(eventToUpdate(diagnostic, true)).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "discarded internal correction" },
    });
  });

  it("suppresses warning notices unless verbose output is enabled", () => {
    const warning = ev("notice", {
      text: "bounded finish pass reached its output ceiling",
      level: "warn",
    });
    expect(eventToUpdate(warning)).toBeNull();
    expect(eventToUpdate(warning, true)).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "bounded finish pass reached its output ceiling" },
    });
  });

  // The real runtime emits tool_call_start as { call: ToolCall } and tool_call_end as
  // { call, ...ToolResult }. The bridge must read those nested shapes too, not just the
  // flat test payloads above.
  it("reads the real runtime tool_call_start payload ({ call })", () => {
    const u = eventToUpdate(
      ev("tool_call_start", { call: { id: "c1", name: "read_file", args: { path: "a.ts" } } }),
    ) as { sessionUpdate: string; toolCallId: string; kind: string; status: string };
    expect(u.sessionUpdate).toBe("tool_call");
    expect(u.toolCallId).toBe("c1");
    expect(u.kind).toBe("read");
    expect(u.status).toBe("in_progress");
  });

  it("reads the real runtime tool_call_end payload ({ call, ...result })", () => {
    const ok = eventToUpdate(
      ev("tool_call_end", { call: { id: "c1", name: "read_file" }, ok: true, output: "done" }),
    ) as { toolCallId: string; status: string };
    expect(ok.toolCallId).toBe("c1");
    expect(ok.status).toBe("completed");
    const bad = eventToUpdate(
      ev("tool_call_end", { call: { id: "c1", name: "bash" }, ok: false, errorMessage: "boom" }),
    ) as { status: string };
    expect(bad.status).toBe("failed");
  });

  it("does not emit a proprietary session update for model_call_start", () => {
    expect(
      eventToUpdate(
        ev("model_call_start", {
          callId: "c1",
          model: "gpt-oss:20b",
          tier: "small",
          reason: "speed: gather",
        }),
      ),
    ).toBeNull();
  });

  it("surfaces terminal stopped assistant messages as agent text", () => {
    expect(
      eventToUpdate(
        ev("assistant_message", {
          text: "(stopped: permission resolution failed)",
          stoppedReason: "permission_error",
        }),
      ),
    ).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "(stopped: permission resolution failed)" },
    });
  });
});

describe("toolKind", () => {
  it("maps tool names onto the ACP kind enum", () => {
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("edit_file")).toBe("edit");
    expect(toolKind("bash")).toBe("execute");
    expect(toolKind("web_fetch")).toBe("fetch");
    expect(toolKind("glob")).toBe("search");
  });
});

describe("deriveStopReason", () => {
  it("maps turn outcome signals to ACP stopReasons", () => {
    expect(deriveStopReason({})).toBe("end_turn");
    expect(deriveStopReason({ aborted: true })).toBe("cancelled");
    expect(deriveStopReason({ capped: true })).toBe("max_turn_requests");
    expect(deriveStopReason({ aborted: true, capped: true })).toBe("cancelled"); // aborted wins
    expect(deriveStopReason({ failed: true })).toBe("refusal");
  });
});

describe("isCapStop", () => {
  it("returns true for an assistant_message with stoppedReason loop_limit", () => {
    expect(isCapStop({ type: "assistant_message", payload: { stoppedReason: "loop_limit" } })).toBe(
      true,
    );
  });

  it("returns true for an assistant_message with stoppedReason stream_watchdog", () => {
    expect(
      isCapStop({ type: "assistant_message", payload: { stoppedReason: "stream_watchdog" } }),
    ).toBe(true);
  });

  it("returns false for an assistant_message with stoppedReason cancelled", () => {
    expect(isCapStop({ type: "assistant_message", payload: { stoppedReason: "cancelled" } })).toBe(
      false,
    );
  });

  it("returns false for an assistant_message with no stoppedReason", () => {
    expect(isCapStop({ type: "assistant_message", payload: { text: "hello" } })).toBe(false);
  });

  it("returns false for a notice event (even with matching text)", () => {
    expect(isCapStop({ type: "notice", payload: { text: "step limit reached" } })).toBe(false);
  });
});
