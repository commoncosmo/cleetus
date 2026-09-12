import { expect, test } from "bun:test";
import { type BuildAttempt, runBuildGate } from "../../../src/agent/build-gate/gate";

const ok: BuildAttempt = { ok: true, errorTail: "" };
const fail = (tail: string): BuildAttempt => ({ ok: false, errorTail: tail });
const live = () => new AbortController().signal;

/** Drives runBuild from a scripted queue of attempts; records how many times fix ran. */
function scripted(attempts: BuildAttempt[]) {
  const queue = [...attempts];
  let fixCalls = 0;
  const fixErrorTails: string[] = [];
  return {
    runBuild: async () => queue.shift() ?? ok,
    fix: async (_errorTail: string, _signal: AbortSignal) => {
      fixCalls++;
      fixErrorTails.push(_errorTail);
    },
    get fixCalls() {
      return fixCalls;
    },
    fixErrorTails,
  };
}

test("passes on the first build: no fix calls", async () => {
  const s = scripted([ok]);
  const res = await runBuildGate({ ...s, maxAttempts: 2, signal: live() });
  expect(res).toEqual({ outcome: "passed", fixRounds: 0 });
  expect(s.fixCalls).toBe(0);
});

test("fails then a fix makes it pass: fixed with fixRounds 1", async () => {
  const s = scripted([fail("err"), ok]);
  const res = await runBuildGate({ ...s, maxAttempts: 2, signal: live() });
  expect(res).toEqual({ outcome: "fixed", fixRounds: 1 });
  expect(s.fixCalls).toBe(1);
  expect(s.fixErrorTails[0]).toBe("err"); // the failing tail is handed to the fixer
});

test("never recovers: failing after exactly maxAttempts rounds, with the final tail", async () => {
  const s = scripted([fail("e1"), fail("e2"), fail("e3")]);
  const res = await runBuildGate({ ...s, maxAttempts: 2, signal: live() });
  expect(res).toEqual({ outcome: "failing", fixRounds: 2, finalErrorTail: "e3" });
  expect(s.fixCalls).toBe(2);
});

test("maxAttempts 0: no fix calls, immediate failing on first failed build", async () => {
  const s = scripted([fail("only")]);
  const res = await runBuildGate({ ...s, maxAttempts: 0, signal: live() });
  expect(res).toEqual({ outcome: "failing", fixRounds: 0, finalErrorTail: "only" });
  expect(s.fixCalls).toBe(0);
});

test("aborted during a fix: stops, reports failing with the latest tail", async () => {
  const controller = new AbortController();
  const res = await runBuildGate({
    runBuild: async () => fail("boom"),
    fix: async () => {
      controller.abort(); // the fix triggers cancellation mid-round
    },
    maxAttempts: 5,
    signal: controller.signal,
  });
  expect(res.outcome).toBe("failing");
  expect(res.finalErrorTail).toBe("boom");
});

test("aborted before the first fix: failing with fixRounds 0, fix never called", async () => {
  const controller = new AbortController();
  controller.abort(); // pre-aborted: the first failed build is followed by an immediate abort exit
  let fixCalls = 0;
  const res = await runBuildGate({
    runBuild: async () => fail("boom"),
    fix: async () => {
      fixCalls++;
    },
    maxAttempts: 3,
    signal: controller.signal,
  });
  expect(res).toEqual({ outcome: "failing", fixRounds: 0, finalErrorTail: "boom" });
  expect(fixCalls).toBe(0);
});
