import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAttachments } from "../../../src/ui/cli/attachments";

const SHA = (n: number) => `${n}`.padStart(64, "0");
let dir: string;
let storeDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-gc-cli-"));
  storeDir = join(dir, ".cleetus", "attachments");
  mkdirSync(storeDir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function orphan(sha: string): string {
  const p = join(storeDir, `${sha}.png`);
  writeFileSync(p, Buffer.from("bytes"));
  const old = (Date.now() - 100 * 60 * 60 * 1000) / 1000;
  utimesSync(p, old, old);
  return p;
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { write: (s: string) => out.push(s), writeErr: (s: string) => err.push(s), out, err };
}

describe("runAttachments", () => {
  it("--dry-run reports orphans but deletes nothing", async () => {
    const p = orphan(SHA(2));
    const sink = io();
    const code = await runAttachments(
      ["node", "cleetus", "attachments", "gc", "--dry-run"],
      dir,
      sink,
    );
    expect(code).toBe(0);
    expect(existsSync(p)).toBe(true);
    expect(sink.out.join("")).toContain("orphans 1");
  });

  it("gc deletes orphans", async () => {
    const p = orphan(SHA(2));
    const sink = io();
    const code = await runAttachments(["node", "cleetus", "attachments", "gc"], dir, sink);
    expect(code).toBe(0);
    expect(existsSync(p)).toBe(false);
  });

  it("rejects an unknown subcommand with usage and exit 2", async () => {
    const sink = io();
    const code = await runAttachments(["node", "cleetus", "attachments", "bogus"], dir, sink);
    expect(code).toBe(2);
    expect(sink.err.join("")).toContain("usage:");
  });
});
