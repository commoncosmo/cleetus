import { describe, expect, it } from "bun:test";
import type { Event, EventType } from "../../src/events/types";
import { latestLearnableTurn } from "../../src/learn/trajectory";

function event(type: EventType, payload: unknown, ts: number): Event {
  return { id: `e-${ts}`, sessionId: "session-1", type, payload, ts };
}

describe("latestLearnableTurn", () => {
  it("extracts the latest completed tool-backed turn and redacts secrets", () => {
    const result = latestLearnableTurn([
      event("user_input", { text: "old turn" }, 1),
      event("assistant_message", { text: "old answer" }, 2),
      event("user_input", { text: "Fetch the weather forecast" }, 3),
      event(
        "notice",
        {
          kind: "skill_auto_invoked",
          skills: ["weather-retrieval"],
          text: "auto-invoked skill: weather-retrieval",
        },
        3.5,
      ),
      event(
        "tool_call_request",
        {
          call: {
            id: "bad",
            name: "web_fetch",
            args: { url: "https://blocked.example", token: "do-not-copy" },
          },
        },
        4,
      ),
      event(
        "tool_call_end",
        {
          call: { id: "bad", name: "web_fetch" },
          ok: false,
          errorMessage: "authorization=super-secret failed",
        },
        5,
      ),
      event(
        "tool_call_request",
        {
          call: {
            id: "good",
            name: "web_fetch",
            args: { url: "https://api.weather.gov/points/1,2" },
          },
        },
        6,
      ),
      event(
        "tool_call_end",
        {
          call: { id: "good", name: "web_fetch" },
          ok: true,
          output: '{"forecast":"https://api.weather.gov/gridpoints/X/1,2/forecast"}',
        },
        7,
      ),
      event("assistant_message", { text: "Forecast retrieved." }, 8),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.userInput).toBe("Fetch the weather forecast");
    expect(result.turn.steps).toHaveLength(2);
    expect(result.turn.steps[0]!.args).toEqual({
      url: "https://blocked.example",
      token: "[REDACTED]",
    });
    expect(result.turn.steps[0]!.errorMessage).not.toContain("super-secret");
    expect(result.turn.steps[1]!.ok).toBe(true);
    expect(result.turn.invokedSkillNames).toEqual(["weather-retrieval"]);
  });

  it("rejects an unfinished turn", () => {
    const result = latestLearnableTurn([event("user_input", { text: "do work" }, 1)]);
    expect(result).toEqual({
      ok: false,
      reason: "the most recent turn has not produced a final response yet",
    });
  });

  it("rejects a structured stop", () => {
    const result = latestLearnableTurn([
      event("user_input", { text: "do work" }, 1),
      event("tool_call_end", { call: { name: "read_file" }, ok: true }, 2),
      event("assistant_message", { text: "stopped", stoppedReason: "loop_limit" }, 3),
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "the most recent turn stopped before completion (loop_limit)",
    });
  });

  it("rejects a response with no successful tool evidence", () => {
    const result = latestLearnableTurn([
      event("user_input", { text: "do work" }, 1),
      event("tool_call_end", { call: { name: "web_fetch" }, ok: false, errorMessage: "403" }, 2),
      event("assistant_message", { text: "I could not do it." }, 3),
    ]);
    expect(result).toEqual({
      ok: false,
      reason: "the most recent turn has no successful tool evidence to turn into a playbook",
    });
  });

  it("bounds long traces while preserving the opening attempts and final successful sequence", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      event(
        "tool_call_end",
        { call: { name: `tool-${index}`, args: { value: "x".repeat(1_000) } }, ok: true },
        index + 2,
      ),
    );
    const result = latestLearnableTurn([
      event("user_input", { text: "perform a long workflow" }, 1),
      ...many,
      event("assistant_message", { text: "done" }, 40),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.steps).toHaveLength(24);
    expect(result.turn.steps[0]!.name).toBe("tool-0");
    expect(result.turn.steps[3]!.name).toBe("tool-3");
    expect(result.turn.steps[4]!.name).toBe("tool-10");
    expect(result.turn.steps.at(-1)!.name).toBe("tool-29");
    expect(JSON.stringify(result.turn.steps[0]!.args)).toContain("argument truncated");
  });

  it("keeps salient setup and repair steps while collapsing repeated verification attempts", () => {
    const steps = Array.from({ length: 40 }, (_, index) =>
      event(
        "tool_call_end",
        {
          call: { name: "read_file", args: { path: `noise-${index}.txt` } },
          ok: true,
          output: "read",
        },
        index + 2,
      ),
    );
    steps[10] = event(
      "tool_call_end",
      {
        call: {
          name: "bash",
          args: { command: "bunx tauri init --ci --app-name Example" },
        },
        ok: true,
        output: "initialized",
      },
      12,
    );
    for (let index = 11; index <= 15; index++) {
      steps[index] = event(
        "tool_call_end",
        {
          call: {
            name: "smoke_run",
            args: { command: "bunx tauri dev", seconds: (index - 10) * 15 },
          },
          ok: false,
          errorMessage: "tauri-plugin-log: Operation not permitted",
        },
        index + 2,
      );
    }
    steps[20] = event(
      "tool_call_end",
      {
        call: {
          name: "edit_file",
          args: { path: "src-tauri/src/lib.rs", old_text: "plugin(log)", new_text: "" },
        },
        ok: true,
        output: "updated",
      },
      22,
    );
    steps[39] = event(
      "tool_call_end",
      {
        call: { name: "smoke_run", args: { command: "bunx tauri dev", seconds: 60 } },
        ok: true,
        output: "Finished dev profile; Running target/debug/app",
      },
      41,
    );

    const result = latestLearnableTurn([
      event("user_input", { text: "Create a Tauri app" }, 1),
      ...steps,
      event("assistant_message", { text: "Scaffolded and launched." }, 50),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.steps).toHaveLength(24);
    expect(
      result.turn.steps.some(
        (step) => step.name === "bash" && JSON.stringify(step.args).includes("bunx tauri init"),
      ),
    ).toBe(true);
    const failedSmoke = result.turn.steps.find((step) => step.name === "smoke_run" && !step.ok);
    expect(failedSmoke?.repeatCount).toBe(5);
    expect(result.turn.steps.some((step) => step.name === "edit_file")).toBe(true);
    expect(result.turn.steps.at(-1)?.output).toContain("Running target/debug/app");
  });
});
