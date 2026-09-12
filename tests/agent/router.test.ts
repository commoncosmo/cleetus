import { describe, expect, it } from "bun:test";
import { appendLocationAnchor } from "../../src/agent/bootstrap-location";
import { type RouterDeps, createRouter, staticRouter } from "../../src/agent/router";
import { DEFAULT_SMART_CONFIG } from "../../src/config/routing";
import type { Message } from "../../src/providers/types";

const TIERS = {
  small: { provider: "lm", model: "small-m" },
  large: { provider: "rm", model: "big-m" },
};

function deps(over: Partial<RouterDeps>): RouterDeps {
  return {
    getMode: () => "manual",
    getActive: () => ({ provider: "lm", model: "active-m" }),
    tiers: TIERS,
    smart: DEFAULT_SMART_CONFIG,
    ...over,
  };
}

const userMsg = (content: string): Message => ({ role: "user", content });

describe("createRouter", () => {
  it("manual mode uses the active model with no tier", () => {
    const r = createRouter(deps({ getMode: () => "manual" }));
    const d = r.select({ turnIndex: 0, messages: [] });
    expect(d.choice).toEqual({ provider: "lm", model: "active-m" });
    expect(d.tier).toBeNull();
    expect(d.reason).toBe("manual");
    expect(r.finishPass()).toBeNull();
  });

  it("speed mode selects small and finishPass returns large", () => {
    const r = createRouter(deps({ getMode: () => "speed" }));
    const sel = r.select({ turnIndex: 0, messages: [] });
    expect(sel.tier).toBe("small");
    expect(sel.reason).toBe("speed: gather");
    const fp = r.finishPass();
    expect(fp?.tier).toBe("large");
    expect(fp?.choice).toEqual(TIERS.large);
    expect(fp?.reason).toContain("finish");
  });

  it("smart mode stays small below all thresholds", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({ turnIndex: 0, messages: [userMsg("hi")] });
    expect(d.tier).toBe("small");
    expect(r.finishPass()).toBeNull();
  });

  it("smart offers the large tier after a reasoned-empty small completion", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const failed = r.select({ turnIndex: 0, messages: [userMsg("look up the weather")] });
    const recovery = r.recoverFromReasonedEmpty?.(
      { turnIndex: 0, messages: [userMsg("look up the weather")] },
      failed,
    );
    expect(recovery).toEqual({
      choice: TIERS.large,
      tier: "large",
      reason: "smart: escalated (small_reasoned_empty)",
      lease: "recovery",
    });
  });

  it("manual and speed modes do not override their configured empty-response flow", () => {
    for (const mode of ["manual", "speed"] as const) {
      const r = createRouter(deps({ getMode: () => mode }));
      const failed = r.select({ turnIndex: 0, messages: [userMsg("hello")] });
      expect(
        r.recoverFromReasonedEmpty?.({ turnIndex: 0, messages: [userMsg("hello")] }, failed),
      ).toBeNull();
    }
  });

  it("smart stays small through deep successful tool loops", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 12,
      messages: [userMsg("hi")],
      toolProgress: { calls: 12, failures: 0, consecutiveFailures: 0 },
    });
    expect(d.tier).toBe("small");
  });

  it("smart escalates after consecutive failed tool outcomes", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 3,
      messages: [userMsg("hi")],
      toolProgress: { calls: 4, failures: 3, consecutiveFailures: 3 },
    });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("consecutive_tool_failures");
  });

  it("smart gives the large tier a recovery lease after retrieval returns to discovery", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 3,
      messages: [userMsg("look up the current weather")],
      toolProgress: {
        calls: 3,
        failures: 0,
        consecutiveFailures: 0,
        retrievalStalled: true,
      },
    });
    expect(d.choice).toEqual(TIERS.large);
    expect(d.reason).toContain("retrieval_stalled");
    expect(d.lease).toBe("recovery");
  });

  it("a successful tool outcome resets the escalation streak", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 8,
      messages: [userMsg("hi")],
      toolProgress: { calls: 8, failures: 5, consecutiveFailures: 0 },
    });
    expect(d.tier).toBe("small");
  });

  it("smart keeps a focused code request small until implementation changes", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({ turnIndex: 0, messages: [userMsg("please refactor this module")] });
    expect(d.tier).toBe("small");
  });

  it("smart starts broad software builds on large", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({ turnIndex: 0, messages: [userMsg("build a web app for the forecast")] });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("broad_code");
  });

  describe("spec turns", () => {
    it("holds host-marked spec answers even when recovery and edit leases have expired", () => {
      const r = createRouter(
        deps({
          getMode: () => "smart",
          smart: { ...DEFAULT_SMART_CONFIG, escalateOnCodeEdit: "never" },
        }),
      );
      const d = r.select({
        specTurn: true,
        turnIndex: 10,
        messages: [userMsg("CORS is already configured. Auto-collapse the thinking pane.")],
        toolProgress: {
          calls: 10,
          failures: 0,
          consecutiveFailures: 0,
          consecutiveSuccesses: 10,
        },
        routingState: {
          previousTier: "large",
          recoveryLeaseActive: true,
          sourceEditEpoch: 1,
          verifiedSourceEditEpoch: 1,
          completionAuditActive: false,
        },
      });
      expect(d.choice).toEqual(TIERS.large);
      expect(d.reason).toBe("smart: escalated (spec_turn)");
      expect(d.lease).toBeUndefined();
    });

    it("preserves manual, speed, and missing-tier behavior for spec revisions", () => {
      const ctx = { specTurn: true, turnIndex: 0, messages: [userMsg("Revise the draft")] };
      const manual = createRouter(deps({ getMode: () => "manual" })).select(ctx);
      expect(manual.choice.model).toBe("active-m");
      expect(manual.reason).toBe("manual");
      const speed = createRouter(deps({ getMode: () => "speed" })).select(ctx);
      expect(speed.choice).toEqual(TIERS.small);
      expect(speed.reason).toBe("speed: gather");
      const noTiers = createRouter(deps({ getMode: () => "smart", tiers: undefined })).select(ctx);
      expect(noTiers.choice.model).toBe("active-m");
      expect(noTiers.tier).toBeNull();
    });

    it("uses the large tier for a /spec drafting turn", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({ turnIndex: 0, messages: [userMsg("/spec build a thing")] });
      expect(d.tier).toBe("large");
      expect(d.reason).toContain("spec_turn");
    });

    it("keeps the large tier after the broad-code cap and a todo_write", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({
        turnIndex: 10,
        messages: [
          userMsg("/spec build a thing"),
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "1", name: "todo_write", args: { todos: [] } }],
          },
        ],
      });
      expect(d.tier).toBe("large");
      expect(d.reason).toContain("spec_turn");
    });

    it("uses the large tier for a bare /spec command", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({ turnIndex: 0, messages: [userMsg("/spec")] });
      expect(d.tier).toBe("large");
      expect(d.reason).toContain("spec_turn");
    });

    it("treats spec-creator but not other skills as a spec turn", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const spec = r.select({
        turnIndex: 0,
        messages: [userMsg("/skill spec-creator write a thing")],
      });
      const other = r.select({
        turnIndex: 0,
        messages: [userMsg("/skill security-scan scan this")],
      });
      expect(spec.tier).toBe("large");
      expect(spec.reason).toContain("spec_turn");
      expect(other.tier).toBe("small");
      expect(other.reason).not.toContain("spec_turn");
    });
  });

  describe("injected <system-reminder> text is not the user's request", () => {
    // The real fresh-directory grounding reminder reads "Build the project directly in the current
    // working directory…" — a build verb + software noun that the classifier would otherwise read
    // as an explicit build request (#319).
    const grounded = (text: string): Message =>
      userMsg(appendLocationAnchor(text, { kind: "cwd" }, "/tmp/proj"));

    it("does not promote a focused request to broad_code because of the grounding reminder", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({ turnIndex: 0, messages: [grounded("Add a page called Stuff")] });
      expect(d.tier).toBe("small");
      expect(d.reason).not.toContain("broad_code");
    });

    it("still escalates a genuine build request when the reminder is attached", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({
        turnIndex: 0,
        messages: [grounded("build a web app for the forecast")],
      });
      expect(d.reason).toContain("broad_code");
    });

    it("ignores an escalation keyword that appears only inside a reminder", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({
        turnIndex: 0,
        messages: [
          userMsg(
            "fix the typo in the readme\n\n<system-reminder>think hard here</system-reminder>",
          ),
        ],
      });
      expect(d.reason).not.toContain("keyword");
      expect(d.tier).toBe("small");
    });
  });

  describe("broad_code planning phase", () => {
    const buildRequest = userMsg("build a web app for the forecast");

    it("keeps escalating while still within the plan-call cap with no checklist", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({ turnIndex: 4, messages: [buildRequest] });
      expect(d.tier).toBe("large");
      expect(d.reason).toContain("broad_code");
    });

    it("stops escalating once a todo_write call appears in the turn, even mid-turn", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const history: Message[] = [
        buildRequest,
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "1", name: "todo_write", args: { todos: [] } }],
        },
      ];
      const d = r.select({ turnIndex: 1, messages: history });
      expect(d.tier).toBe("small");
    });

    it("stops escalating once the plan-call cap is reached with no checklist ever established", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({ turnIndex: 5, messages: [buildRequest] });
      expect(d.tier).toBe("small");
    });

    it("falls through to on_verify_fail after the phase drop, once a subsequent edit's verification fails", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const history: Message[] = [
        buildRequest,
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "1", name: "todo_write", args: { todos: [] } }],
        },
        { role: "tool", content: "ok", toolCallId: "1" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "2", name: "write_file", args: { path: "src/app.ts" } }],
        },
      ];
      const d = r.select({
        turnIndex: 3,
        messages: history,
        routingState: {
          previousTier: "small",
          sourceEditEpoch: 1,
          verifiedSourceEditEpoch: 0,
          completionAuditActive: false,
          failedVerificationEpoch: 1,
        },
      });
      expect(d.tier).toBe("large");
      expect(d.reason).toContain("verification_failed_pending_fix");
    });

    it("stamps the generic release message the first time a broad_code turn drops to small", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({
        turnIndex: 6,
        messages: [buildRequest],
        routingState: {
          previousTier: "large",
          sourceEditEpoch: 0,
          verifiedSourceEditEpoch: 0,
          completionAuditActive: false,
        },
      });
      expect(d.tier).toBe("small");
      expect(d.reason).toContain("lease released");
    });
  });

  it("always: escalates after a source write in the current turn", () => {
    const r = createRouter(
      deps({
        getMode: () => "smart",
        smart: { ...DEFAULT_SMART_CONFIG, escalateOnCodeEdit: "always" },
      }),
    );
    const history: Message[] = [
      userMsg("do it"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "write_file", args: { path: "src/app.ts" } }],
      },
    ];
    const d = r.select({ turnIndex: 1, messages: history });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("source_edit");
  });

  it("always: releases a source-edit lease after current verification", () => {
    const r = createRouter(
      deps({
        getMode: () => "smart",
        smart: { ...DEFAULT_SMART_CONFIG, escalateOnCodeEdit: "always" },
      }),
    );
    const history: Message[] = [
      userMsg("fix this module"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "write_file", args: { path: "src/app.ts" } }],
      },
    ];
    const d = r.select({
      turnIndex: 3,
      messages: history,
      routingState: {
        previousTier: "large",
        sourceEditEpoch: 1,
        verifiedSourceEditEpoch: 1,
        completionAuditActive: false,
      },
    });
    expect(d.tier).toBe("small");
    expect(d.reason).toContain("lease released");
  });

  it("holds a failure-recovery lease through final synthesis", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 4,
      messages: [userMsg("look up the weather")],
      toolProgress: { calls: 4, failures: 3, consecutiveFailures: 0 },
      routingState: {
        previousTier: "large",
        sourceEditEpoch: 0,
        verifiedSourceEditEpoch: 0,
        completionAuditActive: false,
        recoveryLeaseActive: true,
      },
    });
    expect(d.choice).toEqual(TIERS.large);
    expect(d.reason).toContain("recovery_in_progress");
    expect(d.lease).toBe("recovery");
  });

  it("holds the recovery lease below the deescalate-after-successes threshold", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 5,
      messages: [userMsg("look up the weather")],
      toolProgress: { calls: 5, failures: 3, consecutiveFailures: 0, consecutiveSuccesses: 1 },
      routingState: {
        previousTier: "large",
        sourceEditEpoch: 0,
        verifiedSourceEditEpoch: 0,
        completionAuditActive: false,
        recoveryLeaseActive: true,
      },
    });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("recovery_in_progress");
  });

  it("releases the recovery lease once consecutive successes reach the threshold", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 6,
      messages: [userMsg("look up the weather")],
      toolProgress: { calls: 6, failures: 3, consecutiveFailures: 0, consecutiveSuccesses: 2 },
      routingState: {
        previousTier: "large",
        sourceEditEpoch: 0,
        verifiedSourceEditEpoch: 0,
        completionAuditActive: false,
        recoveryLeaseActive: true,
      },
    });
    expect(d.tier).toBe("small");
    expect(d.reason).not.toContain("recovery_in_progress");
  });

  it("always: reacquires the source-edit lease after a newer edit", () => {
    const r = createRouter(
      deps({
        getMode: () => "smart",
        smart: { ...DEFAULT_SMART_CONFIG, escalateOnCodeEdit: "always" },
      }),
    );
    const history: Message[] = [
      userMsg("fix this module"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "write_file", args: { path: "src/app.ts" } }],
      },
    ];
    const d = r.select({
      turnIndex: 4,
      messages: history,
      routingState: {
        previousTier: "small",
        sourceEditEpoch: 2,
        verifiedSourceEditEpoch: 1,
        completionAuditActive: false,
      },
    });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("source_edit_pending_verification");
  });

  describe("on_verify_fail mode (the default)", () => {
    const editHistory: Message[] = [
      userMsg("fix this module"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "write_file", args: { path: "src/app.ts" } }],
      },
    ];

    it("does not escalate on the edit alone, with no verification yet", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({
        turnIndex: 1,
        messages: editHistory,
        routingState: {
          previousTier: "small",
          sourceEditEpoch: 1,
          verifiedSourceEditEpoch: 0,
          completionAuditActive: false,
        },
      });
      expect(d.tier).toBe("small");
    });

    it("escalates once a qualifying verification fails at the edit epoch", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({
        turnIndex: 2,
        messages: editHistory,
        routingState: {
          previousTier: "small",
          sourceEditEpoch: 1,
          verifiedSourceEditEpoch: 0,
          completionAuditActive: false,
          failedVerificationEpoch: 1,
        },
      });
      expect(d.tier).toBe("large");
      expect(d.reason).toContain("verification_failed_pending_fix");
    });

    it("a newer edit clears a stale verification failure", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({
        turnIndex: 3,
        messages: editHistory,
        routingState: {
          previousTier: "small",
          sourceEditEpoch: 2,
          verifiedSourceEditEpoch: 0,
          completionAuditActive: false,
          failedVerificationEpoch: 1,
        },
      });
      expect(d.tier).toBe("small");
    });

    it("a same-epoch pass after a failure clears it", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({
        turnIndex: 3,
        messages: editHistory,
        routingState: {
          previousTier: "large",
          sourceEditEpoch: 1,
          verifiedSourceEditEpoch: 1,
          completionAuditActive: false,
          failedVerificationEpoch: 1,
        },
      });
      expect(d.tier).toBe("small");
    });

    it("preview/pure callers with no routing state do not escalate", () => {
      const r = createRouter(deps({ getMode: () => "smart" }));
      const d = r.select({ turnIndex: 1, messages: editHistory });
      expect(d.tier).toBe("small");
    });
  });

  it("never: disables both broad-code and edit-triggered escalation", () => {
    const r = createRouter(
      deps({
        getMode: () => "smart",
        smart: { ...DEFAULT_SMART_CONFIG, escalateOnCodeEdit: "never" },
      }),
    );
    const broad = r.select({
      turnIndex: 0,
      messages: [userMsg("build a web app for the forecast")],
    });
    expect(broad.tier).toBe("small");
    const history: Message[] = [
      userMsg("fix this module"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "write_file", args: { path: "src/app.ts" } }],
      },
    ];
    const edited = r.select({
      turnIndex: 1,
      messages: history,
      routingState: {
        previousTier: "small",
        sourceEditEpoch: 1,
        verifiedSourceEditEpoch: 0,
        completionAuditActive: false,
        failedVerificationEpoch: 1,
      },
    });
    expect(edited.tier).toBe("small");
  });

  it("holds the large tier during completion audit even after verification", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 5,
      messages: [userMsg("fix this module")],
      routingState: {
        previousTier: "large",
        sourceEditEpoch: 1,
        verifiedSourceEditEpoch: 1,
        completionAuditActive: true,
      },
    });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("completion_audit");
  });

  it("broad_code escalation stops once the plan-call cap is reached, even with previous large tier", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 5,
      messages: [userMsg("build a web app for the forecast")],
      routingState: {
        previousTier: "large",
        sourceEditEpoch: 1,
        verifiedSourceEditEpoch: 1,
        completionAuditActive: false,
      },
    });
    expect(d.tier).toBe("small");
  });

  it("supportsEscalationRequest is true only in smart mode with tiers configured", () => {
    expect(createRouter(deps({ getMode: () => "smart" })).supportsEscalationRequest?.()).toBe(true);
    expect(createRouter(deps({ getMode: () => "manual" })).supportsEscalationRequest?.()).toBe(
      false,
    );
    expect(
      createRouter(
        deps({ getMode: () => "smart", tiers: undefined }),
      ).supportsEscalationRequest?.(),
    ).toBe(false);
  });

  it("escalates when the small tier calls request_escalation, with a recovery lease", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const history: Message[] = [
      userMsg("fix this"),
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "1", name: "request_escalation", args: { reason: "needs careful reasoning" } },
        ],
      },
    ];
    const d = r.select({ turnIndex: 1, messages: history });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("model_requested");
    expect(d.lease).toBe("recovery");
  });

  it("ignores a request_escalation call from a completed prior turn", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const history: Message[] = [
      userMsg("fix this"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "request_escalation", args: { reason: "old" } }],
      },
      { role: "tool", content: "ack", toolCallId: "1" },
      { role: "assistant", content: "done" },
      userMsg("what time is it?"),
    ];
    const d = r.select({ turnIndex: 0, messages: history });
    expect(d.tier).toBe("small");
  });

  it("smart keeps JSON artifact writes on small", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const history: Message[] = [
      userMsg("save those results as a json file"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "write_file", args: { path: "forecast.json" } }],
      },
    ];
    expect(r.select({ turnIndex: 1, messages: history }).tier).toBe("small");
  });

  it("ignores write tool calls from completed turns", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const history: Message[] = [
      userMsg("edit it"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "write_file", args: { path: "src/app.ts" } }],
      },
      { role: "tool", content: "ok", toolCallId: "1" },
      { role: "assistant", content: "done" },
      userMsg("what time is it?"),
    ];
    const d = r.select({ turnIndex: 0, messages: history });
    expect(d.tier).toBe("small");
  });

  it("keeps synthetic user reminders inside the real runtime turn", () => {
    const r = createRouter(
      deps({
        getMode: () => "smart",
        smart: { ...DEFAULT_SMART_CONFIG, escalateOnCodeEdit: "always" },
      }),
    );
    const history: Message[] = [
      userMsg("save the results"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "write_file", args: { path: "src/app.ts" } }],
      },
      { role: "tool", content: "ok", toolCallId: "1" },
      { role: "assistant", content: "done" },
      userMsg("<system-reminder>Audit the completed change.</system-reminder>"),
    ];
    const d = r.select({ turnIndex: 2, messages: history, turnStartIndex: 0 });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("source_edit");
  });

  it("smart escalates on assembled context pressure", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 0,
      messages: [userMsg("summarize this")],
      contextPressure: { inputTokens: 70_000, capacityTokens: 100_000 },
    });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("context_pressure>=70%");
  });

  it("stays small when a large raw result is compacted below the pressure threshold", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({
      turnIndex: 2,
      messages: [userMsg("weather"), { role: "tool", content: "x".repeat(50_000) }],
      contextPressure: { inputTokens: 9_000, capacityTokens: 94_000 },
    });
    expect(d.tier).toBe("small");
  });

  it("smart escalates on explicit keyword", () => {
    const r = createRouter(deps({ getMode: () => "smart" }));
    const d = r.select({ turnIndex: 0, messages: [userMsg("think hard about this")] });
    expect(d.tier).toBe("large");
    expect(d.reason).toContain("keyword");
  });

  it("keyword matching respects word boundaries, not bare substrings", () => {
    const r = createRouter(
      deps({
        getMode: () => "smart",
        smart: { ...DEFAULT_SMART_CONFIG, keywords: ["test"] },
      }),
    );
    const insideWord = r.select({ turnIndex: 0, messages: [userMsg("keep testing this")] });
    expect(insideWord.tier).toBe("small");
    const wholeWord = r.select({ turnIndex: 0, messages: [userMsg("run a test on this")] });
    expect(wholeWord.tier).toBe("large");
  });

  it("multi-word keyword phrases still match across their own word boundaries", () => {
    const r = createRouter(
      deps({
        getMode: () => "smart",
        smart: { ...DEFAULT_SMART_CONFIG, keywords: ["think hard"] },
      }),
    );
    const noMatch = r.select({ turnIndex: 0, messages: [userMsg("rethink hard problems")] });
    expect(noMatch.tier).toBe("small");
    const match = r.select({ turnIndex: 0, messages: [userMsg("please think hard here")] });
    expect(match.tier).toBe("large");
  });

  it("falls back to active model in speed/smart when tiers are missing", () => {
    const r = createRouter(deps({ getMode: () => "speed", tiers: undefined }));
    const d = r.select({ turnIndex: 0, messages: [] });
    expect(d.choice).toEqual({ provider: "lm", model: "active-m" });
    expect(d.tier).toBeNull();
    expect(d.reason).toContain("no tiers");
    expect(r.finishPass()).toBeNull();
  });

  it("staticRouter always returns the fixed choice and never finishes", () => {
    const r = staticRouter({ provider: "p", model: "m" });
    expect(r.select({ turnIndex: 5, messages: [] }).choice).toEqual({ provider: "p", model: "m" });
    expect(r.finishPass()).toBeNull();
  });
});
