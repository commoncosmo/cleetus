import { afterEach, expect, spyOn, test } from "bun:test";
import {
  enableStartupTimings,
  startupAsync,
  startupReady,
  startupSync,
} from "../../src/lib/startup-timings";

afterEach(() => {
  enableStartupTimings(false);
});

test("startup timing is opt-in, uses stderr, and preserves results and errors", async () => {
  const output: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((text) => {
    output.push(String(text));
    return true;
  });
  try {
    enableStartupTimings(false);
    expect(startupSync("silent", () => 42)).toBe(42);
    expect(output).toEqual([]);
    enableStartupTimings(true);
    expect(await startupAsync("provider discovery", async () => 42)).toBe(42);
    const failure = new Error("expected failure");
    expect(() =>
      startupSync("ACL failure", () => {
        throw failure;
      }),
    ).toThrow(failure);
    await expect(
      startupAsync("async failure", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    startupReady();
    expect(output.length).toBe(4);
    expect(output.join("")).toContain("[cleetus startup] provider discovery:");
    expect(output.join("")).toContain("ready (process total)");
    expect(output.join("")).not.toContain("expected failure");
  } finally {
    stderr.mockRestore();
  }
});
