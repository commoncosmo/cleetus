import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { drainEditorInput } from "../../src/editor/terminal";

class FakeTerminalInput extends EventEmitter {
  readonly chunks: string[] = [];

  read(): string | null {
    return this.chunks.shift() ?? null;
  }

  send(chunk: string): void {
    this.chunks.push(chunk);
    this.emit("readable");
  }
}

describe("drainEditorInput", () => {
  test("discards queued and slightly delayed terminal replies before returning", async () => {
    const input = new FakeTerminalInput();
    input.chunks.push("\u001B[2;2R");

    const drained = drainEditorInput(input, { quietMs: 8, maxMs: 100 });
    setTimeout(() => input.send("\u001B]10;rgb:e6ce/e6ce/e6ce\u0007"), 2);
    await drained;

    expect(input.chunks).toEqual([]);
    expect(input.listenerCount("readable")).toBe(0);
  });

  test("uses a hard deadline when input never becomes quiet", async () => {
    const input = new FakeTerminalInput();
    const interval = setInterval(() => input.send("\u001B[3;3R"), 2);

    await drainEditorInput(input, { quietMs: 20, maxMs: 8 });
    clearInterval(interval);

    expect(input.listenerCount("readable")).toBe(0);
  });
});
