import { describe, expect, it } from "bun:test";
import {
  specExecutionControls,
  specExecutionKeyAction,
} from "../../../src/ui/tui/spec-execution-prompt";

const plain = { return: false, escape: false };
const full = { orchestrationAvailable: true, orchestrationRetry: false };
const retry = { orchestrationAvailable: true, orchestrationRetry: true };
const noOrch = { orchestrationAvailable: false, orchestrationRetry: false };

describe("specExecutionKeyAction", () => {
  it("maps enter and p to plan — the non-destructive default", () => {
    expect(specExecutionKeyAction("", { ...plain, return: true }, full)).toBe("plan");
    expect(specExecutionKeyAction("p", plain, full)).toBe("plan");
    expect(specExecutionKeyAction("P", plain, full)).toBe("plan");
  });

  it("maps g to go; enter never means go here", () => {
    expect(specExecutionKeyAction("g", plain, full)).toBe("go");
    expect(specExecutionKeyAction("G", plain, full)).toBe("go");
    expect(specExecutionKeyAction("", { ...plain, return: true }, noOrch)).toBe("plan");
  });

  it("maps o to orchestrate only when orchestration is available", () => {
    expect(specExecutionKeyAction("o", plain, full)).toBe("orchestrate");
    expect(specExecutionKeyAction("O", plain, full)).toBe("orchestrate");
    expect(specExecutionKeyAction("o", plain, noOrch)).toBeNull();
  });

  it("maps r to repair only on an orchestration retry with orchestration available", () => {
    expect(specExecutionKeyAction("r", plain, retry)).toBe("repair");
    expect(specExecutionKeyAction("R", plain, retry)).toBe("repair");
    expect(specExecutionKeyAction("r", plain, full)).toBeNull();
    expect(
      specExecutionKeyAction("r", plain, {
        orchestrationAvailable: false,
        orchestrationRetry: true,
      }),
    ).toBeNull();
  });

  it("maps esc to cancel", () => {
    expect(specExecutionKeyAction("", { ...plain, escape: true }, full)).toBe("cancel");
  });

  it("ignores every other key", () => {
    for (const k of ["a", "s", "e", "x", " ", "1"]) {
      expect(specExecutionKeyAction(k, plain, retry)).toBeNull();
    }
  });
});

describe("specExecutionControls", () => {
  it("lists plan/orchestrate/go/cancel when orchestration is available", () => {
    expect(specExecutionControls(full)).toBe("enter/p plan · o orchestrate · g go · esc cancel");
  });
  it("omits orchestrate when it is unavailable", () => {
    expect(specExecutionControls(noOrch)).toBe("enter/p plan · g go · esc cancel");
  });
  it("offers repair and retry-as-is on an orchestration retry", () => {
    expect(specExecutionControls(retry)).toBe(
      "r repair decomposition · o retry as-is · enter/p plan · g go · esc cancel",
    );
  });
});
