import { describe, expect, it } from "bun:test";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import { stripSystemReminders } from "../../src/skills/compose";
import { buildSkillRegistry } from "../../src/skills/registry";
import type { Skill } from "../../src/skills/types";
import { buildCommandRegistry } from "../../src/slash/commands";
import type { SlashContext } from "../../src/slash/types";

const scan: Skill = {
  name: "security-scan",
  description: "Scan for issues",
  source: "built-in",
  body: "SCAN BODY",
};
const review: Skill = {
  name: "review",
  description: "Code review",
  source: "project",
  body: "REVIEW BODY",
  filePath: "/project/.cleetus/skills/review.md",
};

function setup() {
  const registry = buildSkillRegistry([scan], [review]);
  const reg = buildCommandRegistry({
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "lm", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    getSkills: () => registry,
  });
  return reg;
}

async function run(
  reg: ReturnType<typeof buildCommandRegistry>,
  args: string,
  ctx: Partial<SlashContext> = {},
): Promise<{ out: string; seeded: string[] }> {
  const out: string[] = [];
  const seeded: string[] = [];
  await reg.get("skill")!.run(args, {
    cwd: ".",
    print: (s) => out.push(s),
    runPrompt: async (t) => {
      seeded.push(t);
    },
    ...ctx,
  });
  return { out: out.join("\n"), seeded };
}

describe("/skill", () => {
  it("lists available skills when given no argument", async () => {
    const { out } = await run(setup(), "");
    expect(out).toContain("security-scan — Scan for issues");
    expect(out).toContain("review — Code review");
    expect(out).toContain("/skill <name>");
  });

  it("seeds a turn showing the command as typed, with the playbook hidden in a reminder", async () => {
    const { seeded } = await run(setup(), "security-scan only the diff");
    expect(seeded).toHaveLength(1);
    expect(stripSystemReminders(seeded[0]!)).toBe("/skill security-scan only the diff");
    expect(seeded[0]).toContain("SCAN BODY");
    expect(seeded[0]).toContain("User request / arguments: only the diff");
  });

  it("resolves an unambiguous prefix and shows the canonical skill name", async () => {
    const { seeded } = await run(setup(), "rev");
    expect(stripSystemReminders(seeded[0]!)).toBe("/skill review");
    expect(seeded[0]).toContain("REVIEW BODY");
    expect(seeded[0]).toContain("(No additional arguments were provided.)");
  });

  it("errors on an unknown skill and lists the available names", async () => {
    const { out, seeded } = await run(setup(), "nope");
    expect(out).toContain("unknown skill 'nope'");
    expect(out).toContain("review, security-scan");
    expect(seeded).toHaveLength(0);
  });

  it("reports when runPrompt is unavailable (non-interactive)", async () => {
    const { out } = await run(setup(), "security-scan", { runPrompt: undefined });
    expect(out).toContain("skills require interactive mode");
  });

  it("opens a user skill source and reloads it after the editor returns", async () => {
    const registry = buildSkillRegistry([], [review]);
    const calls: string[] = [];
    const reg = buildCommandRegistry({
      providers: new ProviderRegistry(),
      getActive: () => ({ provider: "lm", model: "m" }),
      setActive: () => {},
      getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
      getSkills: () => registry,
      prepareSkillEditorTarget: (skill) => {
        calls.push(`secure:${skill.filePath}`);
        return "/verified/review.md";
      },
      reloadSkill: async (name, expectedFilePath) => {
        calls.push(`reload:${name}:${expectedFilePath}`);
        return {
          skill: { ...review, body: "UPDATED" },
          warnings: ["example warning"],
        };
      },
    });

    const { out, seeded } = await run(reg, "edit review", {
      openEditor: async ({ targets }) => {
        calls.push(`edit:${targets?.join(",")}`);
      },
    });

    expect(calls).toEqual([
      "secure:/project/.cleetus/skills/review.md",
      "edit:/verified/review.md",
      "reload:review:/project/.cleetus/skills/review.md",
    ]);
    expect(out).toContain("Reloaded project skill 'review'");
    expect(out).toContain("example warning");
    expect(seeded).toEqual([]);
  });

  it("keeps built-in skills read-only", async () => {
    const { out } = await run(setup(), "edit security-scan", {
      openEditor: async () => {
        throw new Error("must not open");
      },
    });
    expect(out).toContain("built in and has no editable source file");
  });

  it("supports explicit /skill run for a skill named edit", async () => {
    const editSkill: Skill = {
      name: "edit",
      description: "An unfortunately named skill",
      source: "project",
      body: "EDIT SKILL",
      filePath: "/project/.cleetus/skills/edit.md",
    };
    const registry = buildSkillRegistry([], [editSkill]);
    const reg = buildCommandRegistry({
      providers: new ProviderRegistry(),
      getActive: () => ({ provider: "lm", model: "m" }),
      setActive: () => {},
      getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
      getSkills: () => registry,
    });
    const { seeded } = await run(reg, "run edit");
    expect(seeded[0]).toContain("EDIT SKILL");
  });

  it("hides the command when skills deps are absent", () => {
    const reg = buildCommandRegistry({
      providers: new ProviderRegistry(),
      getActive: () => ({ provider: "lm", model: "m" }),
      setActive: () => {},
      getPermissions: () => ({ project: [], global: [] }) as PermissionRules,
    });
    expect(reg.get("skill")).toBeUndefined();
  });
});
