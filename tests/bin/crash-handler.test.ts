import { describe, expect, it } from "bun:test";
import { makeCrashHandler } from "../../src/bin/crash-handler";

function spy() {
  const calls: string[] = [];
  return {
    calls,
    unmount: () => calls.push("unmount"),
    logError: (m: string) => calls.push(`log:${m}`),
    write: (_s: string) => calls.push("write"),
    exit: (_c: number) => calls.push("exit"),
  };
}

describe("makeCrashHandler", () => {
  it("runs unmount → log → write → exit in order", () => {
    const s = spy();
    makeCrashHandler(s)(new Error("boom"));
    expect(s.calls).toEqual(["unmount", "log:boom", "write", "exit"]);
  });

  it("is a no-op on a second invocation", () => {
    const s = spy();
    const h = makeCrashHandler(s);
    h(new Error("first"));
    h(new Error("second"));
    expect(s.calls.filter((c) => c === "exit")).toHaveLength(1);
  });

  it("still exits when unmount throws", () => {
    const calls: string[] = [];
    makeCrashHandler({
      unmount: () => {
        throw new Error("ink dead");
      },
      logError: () => calls.push("log"),
      write: () => calls.push("write"),
      exit: () => calls.push("exit"),
    })(new Error("boom"));
    expect(calls).toEqual(["log", "write", "exit"]);
  });

  it("coerces a non-Error reason to a message", () => {
    const s = spy();
    makeCrashHandler(s)("string failure");
    expect(s.calls.some((c) => c.startsWith("log:string failure"))).toBe(true);
  });
});
