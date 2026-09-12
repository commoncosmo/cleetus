import { expect, test } from "bun:test";
import { spawnCollect } from "../../src/sandbox/spawn";

test("spawnCollect pipes stdin to the child", async () => {
  const r = await spawnCollect(["cat"], {
    signal: new AbortController().signal,
    stdin: "hello-payload",
  });
  expect(r.stdout).toBe("hello-payload");
  expect(r.exitCode).toBe(0);
});

test("spawnCollect with no stdin still works (stdin ignored)", async () => {
  const r = await spawnCollect(["echo", "hi"], { signal: new AbortController().signal });
  expect(r.stdout.trim()).toBe("hi");
});
