import { describe, expect, it } from "bun:test";
import { AcpTurnQueue } from "../../src/acp/turn-queue";

describe("AcpTurnQueue", () => {
  it("runs connection-global turn adapters in FIFO order without overlap", async () => {
    const queue = new AcpTurnQueue();
    const trace: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      trace.push("first:start");
      await firstGate;
      trace.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      trace.push("second:start");
      trace.push("second:end");
      return 2;
    });

    await Promise.resolve();
    expect(trace).toEqual(["first:start"]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(trace).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("releases the next turn after an operation throws", async () => {
    const queue = new AcpTurnQueue();
    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    const recovered = queue.run(async () => "ok");

    await expect(failed).rejects.toThrow("boom");
    expect(await recovered).toBe("ok");
  });
});
