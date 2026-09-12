import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RememberTool } from "../../src/memory/remember-tool";
import { MemoryStore } from "../../src/memory/store";
import type { ToolContext } from "../../src/tools/types";

const ctx = (): ToolContext => ({ projectDir: "/", abortSignal: new AbortController().signal });

let dir: string;
let stores: { global: MemoryStore; project: MemoryStore };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-remtool-"));
  stores = {
    global: new MemoryStore(join(dir, "global.md")),
    project: new MemoryStore(join(dir, "project.md")),
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("RememberTool", () => {
  it("defaults to the project scope", async () => {
    const res = await new RememberTool(stores).run({ text: "use bun" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe(`remembered (project) → ${join(dir, "project.md")}: use bun`);
    expect(stores.project.list()).toEqual(["use bun"]);
    expect(stores.global.list()).toEqual([]);
  });

  it("targets the global scope when asked", async () => {
    await new RememberTool(stores).run({ text: "I prefer dark mode", scope: "global" }, ctx());
    expect(stores.global.list()).toEqual(["I prefer dark mode"]);
    expect(stores.project.list()).toEqual([]);
  });

  it("no-ops on empty text", async () => {
    const res = await new RememberTool(stores).run({ text: "   " }, ctx());
    expect(res.output).toContain("nothing to remember");
    expect(stores.project.list()).toEqual([]);
  });

  it("reports the actual file path it saved to (so the model can't confabulate one)", async () => {
    const res = await new RememberTool(stores).run(
      { text: "boreal bytes", scope: "global" },
      ctx(),
    );
    expect(res.output).toContain("remembered (global)");
    expect(res.output).toContain(join(dir, "global.md"));
    expect(res.output).toContain("boreal bytes");
  });
});

describe("RememberTool default scope", () => {
  it("defaults to global when constructed with defaultScope 'global'", async () => {
    const tool = new RememberTool(stores, "global");
    await tool.run({ text: "always uses tabs" }, ctx());
    expect(stores.global.list()).toEqual(["always uses tabs"]);
    expect(stores.project.list()).toEqual([]);
  });

  it("explicit scope still wins over the default", async () => {
    const tool = new RememberTool(stores, "global");
    await tool.run({ text: "this repo uses zod", scope: "project" }, ctx());
    expect(stores.project.list()).toEqual(["this repo uses zod"]);
    expect(stores.global.list()).toEqual([]);
  });

  it("default is 'project' when unspecified (unchanged behavior)", async () => {
    const tool = new RememberTool(stores);
    await tool.run({ text: "note" }, ctx());
    expect(stores.project.list()).toEqual(["note"]);
    expect(stores.global.list()).toEqual([]);
  });
});
