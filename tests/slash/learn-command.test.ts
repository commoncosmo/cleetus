import { describe, expect, it } from "bun:test";
import type { LearnPlaybookController } from "../../src/learn/service";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

function setup() {
  const calls: string[] = [];
  const learn: LearnPlaybookController = {
    propose: async () => {
      calls.push("draft");
      return "DRAFT";
    },
    save: async (scope) => {
      calls.push(`save:${scope}`);
      return `SAVED:${scope}`;
    },
    discard: () => {
      calls.push("discard");
      return "DISCARDED";
    },
    status: () => {
      calls.push("status");
      return "STATUS";
    },
  };
  const reg = buildCommandRegistry({
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "p", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    learnPlaybook: learn,
  });
  return { reg, calls };
}

async function run(reg: ReturnType<typeof buildCommandRegistry>, args: string): Promise<string> {
  const out: string[] = [];
  await reg.get("learn")!.run(args, { cwd: ".", print: (text) => out.push(text) });
  return out.join("\n");
}

describe("/learn", () => {
  it("drafts from the previous turn when invoked bare", async () => {
    const { reg, calls } = setup();
    expect(await run(reg, "")).toBe("DRAFT");
    expect(calls).toEqual(["draft"]);
  });

  it("saves the exact pending draft to an explicit scope", async () => {
    const { reg, calls } = setup();
    expect(await run(reg, "save global")).toBe("SAVED:global");
    expect(calls).toEqual(["save:global"]);
  });

  it("supports status and discard", async () => {
    const { reg, calls } = setup();
    expect(await run(reg, "status")).toBe("STATUS");
    expect(await run(reg, "discard")).toBe("DISCARDED");
    expect(calls).toEqual(["status", "discard"]);
  });

  it("requires a valid save scope", async () => {
    const { reg, calls } = setup();
    expect(await run(reg, "save")).toContain("usage:");
    expect(await run(reg, "save session")).toContain("usage:");
    expect(calls).toEqual([]);
  });

  it("is hidden when the controller is not wired", () => {
    const reg = buildCommandRegistry({
      providers: new ProviderRegistry(),
      getActive: () => ({ provider: "p", model: "m" }),
      setActive: () => {},
      getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    });
    expect(reg.get("learn")).toBeUndefined();
  });
});
