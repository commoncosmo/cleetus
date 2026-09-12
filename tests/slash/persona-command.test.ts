import { describe, expect, it } from "bun:test";
import type { PersonaId } from "../../src/agent/personas";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

function setup(
  initial: PersonaId,
  opts: { onShowPersona?: () => void; systemPromptOverridden?: boolean } = {},
) {
  let id: PersonaId = initial;
  const reg = buildCommandRegistry({
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "lm", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    getPersona: () => id,
    setPersona: (p) => {
      id = p;
    },
    onShowPersona: opts.onShowPersona,
    systemPromptOverridden: opts.systemPromptOverridden,
  });
  return { reg, getId: () => id };
}

async function run(reg: ReturnType<typeof buildCommandRegistry>, args: string): Promise<string> {
  const out: string[] = [];
  await reg.get("persona")!.run(args, { cwd: ".", print: (s) => out.push(s) });
  return out.join("\n");
}

describe("/persona", () => {
  it("shows status with a star on the current persona", async () => {
    const { reg } = setup("coding");
    const out = await run(reg, "");
    expect(out).toMatch(/\* coding/);
    expect(out).toMatch(/chat/);
  });

  it("opens the picker when onShowPersona is provided and no arg is given", async () => {
    let opened = false;
    const { reg } = setup("coding", {
      onShowPersona: () => {
        opened = true;
      },
    });
    await run(reg, "");
    expect(opened).toBe(true);
  });

  it("switches persona on a valid id (and prefix)", async () => {
    const { reg, getId } = setup("coding");
    const out = await run(reg, "ch");
    expect(getId()).toBe("chat");
    expect(out).toMatch(/persona: chat/);
  });

  it("errors on an unknown persona and lists valid ids", async () => {
    const { reg, getId } = setup("coding");
    const out = await run(reg, "wizard");
    expect(getId()).toBe("coding");
    expect(out).toMatch(/unknown persona/);
    expect(out).toMatch(/coding, chat, concise/);
  });

  it("hides the command when persona deps are absent", () => {
    const reg = buildCommandRegistry({
      providers: new ProviderRegistry(),
      getActive: () => ({ provider: "lm", model: "m" }),
      setActive: () => {},
      getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    });
    expect(reg.get("persona")).toBeUndefined();
  });

  it("notes an active system_prompt_file override when switching", async () => {
    const { reg, getId } = setup("coding", { systemPromptOverridden: true });
    const out = await run(reg, "chat");
    expect(getId()).toBe("chat");
    expect(out).toMatch(/persona: chat/);
    expect(out).toMatch(/system_prompt_file override active/);
  });

  it("notes an active override in the status listing", async () => {
    const { reg } = setup("coding", { systemPromptOverridden: true });
    const out = await run(reg, "");
    expect(out).toMatch(/\* coding/);
    expect(out).toMatch(/system_prompt_file override active/);
  });

  it("prints no note when the override is inactive", async () => {
    const { reg } = setup("coding");
    expect(await run(reg, "chat")).not.toMatch(/override active/);
  });
});
