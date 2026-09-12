import { expect, test } from "bun:test";
import { runOneShot } from "../../../src/ui/cli/one-shot";

test("runOneShot forwards attachments to runTurn", async () => {
  const calls: unknown[][] = [];
  const fakeRuntime = {
    runTurn: async (...args: unknown[]) => {
      calls.push(args);
      return {};
    },
    loadSession: () => {},
  } as never;
  const fakeSessions = {
    create: () => ({ id: "S" }),
    get: () => undefined,
  } as never;
  const fakeLog = { subscribe: () => () => {} } as never;
  const ref = { mime: "image/png", path: "/tmp/a.png", sha256: "abc" };
  await runOneShot({
    runtime: fakeRuntime,
    log: fakeLog,
    sessions: fakeSessions,
    provider: "lm",
    model: "m",
    prompt: "hi",
    write: () => {},
    attachments: [ref],
  });
  expect(calls[0]).toEqual(["S", "hi", undefined, undefined, undefined, [ref]]);
});
