import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

const baseDeps = {
  providers: new ProviderRegistry(),
  getActive: () => ({ provider: "p", model: "m" }),
  setActive: () => {},
  getPermissions: () => ({ project: [], global: [] }),
};

let dir: string;
let mem: { global: MemoryStore; project: MemoryStore };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-memcmd-"));
  mem = {
    global: new MemoryStore(join(dir, "g.md")),
    project: new MemoryStore(join(dir, "p.md")),
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runMemory(args: string): Promise<string> {
  const reg = buildCommandRegistry({ ...baseDeps, memory: mem });
  const out: string[] = [];
  await reg.get("memory")!.run(args, { cwd: "/", print: (s) => out.push(s) });
  return out.join("\n");
}

describe("/memory command", () => {
  it("is hidden when the memory dep is absent", () => {
    expect(buildCommandRegistry(baseDeps).get("memory")).toBeUndefined();
  });

  it("lists grouped and continuously numbered", async () => {
    mem.global.add("g1");
    mem.project.add("p1");
    mem.project.add("p2");
    const text = await runMemory("");
    expect(text).toContain("Global:");
    expect(text).toContain("1. g1");
    expect(text).toContain("Project:");
    expect(text).toContain("2. p1");
    expect(text).toContain("3. p2");
  });

  it("forgets the right entry across scopes", async () => {
    mem.global.add("g1");
    mem.project.add("p1");
    mem.project.add("p2");
    const text = await runMemory("forget 2");
    expect(text).toContain("p1");
    expect(mem.project.list()).toEqual(["p2"]);
    expect(mem.global.list()).toEqual(["g1"]);
  });

  it("rejects an out-of-range forget", async () => {
    mem.global.add("g1");
    expect(await runMemory("forget 9")).toContain("no memory numbered 9");
  });

  it("reports an empty list", async () => {
    expect(await runMemory("list")).toContain("no memories yet");
  });

  it("adds to the project scope", async () => {
    await runMemory("add hello world");
    expect(mem.project.list()).toEqual(["hello world"]);
  });
});
