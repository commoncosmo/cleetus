import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppState, writeAppState } from "../../src/config/app-state";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cleetus-state-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("app-state", () => {
  it("missing file reads as empty state", async () => {
    expect(await readAppState(root)).toEqual({});
  });

  it("round-trips the sandbox ack", async () => {
    await writeAppState(root, { sandboxDegradedAck: true });
    expect((await readAppState(root)).sandboxDegradedAck).toBe(true);
    expect(await readFile(join(root, "state.yaml"), "utf8")).toContain(
      "sandbox_degraded_ack: true",
    );
  });

  it("merge-preserves unknown keys on write", async () => {
    await writeFile(join(root, "state.yaml"), "future_key: 7\n");
    await writeAppState(root, { sandboxDegradedAck: true });
    const text = await readFile(join(root, "state.yaml"), "utf8");
    expect(text).toContain("future_key: 7");
    expect(text).toContain("sandbox_degraded_ack: true");
  });

  it("invalid YAML reads as empty and does not throw", async () => {
    await writeFile(join(root, "state.yaml"), ": : :\n[");
    expect(await readAppState(root)).toEqual({});
  });
});
