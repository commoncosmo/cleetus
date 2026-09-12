import { describe, expect, test } from "bun:test";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildSkillRegistry } from "../../src/skills/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

describe("/workflow", () => {
  test("is advertised only when a shared controller is supplied", async () => {
    const handled: string[] = [];
    const registry = buildCommandRegistry({
      providers: new ProviderRegistry(),
      getActive: () => ({ provider: "none", model: "none" }),
      setActive() {},
      getPermissions: () => ({ project: [], global: [] }),
      workflowController: {
        async handle(args: string) {
          handled.push(args);
        },
      } as never,
    });
    expect(registry.get("workflow")).toBeDefined();
    await registry.get("workflow")!.run("dry-run weather", {
      cwd: "/work",
      print() {},
    });
    expect(handled).toEqual(["dry-run weather"]);
  });

  test("redirects /skill workflow-creator without entering the agent loop", async () => {
    const handled: string[] = [];
    let ranPrompt = false;
    const workflowController = {
      async handle(args: string) {
        handled.push(args);
      },
    } as never;
    const registry = buildCommandRegistry({
      providers: new ProviderRegistry(),
      getActive: () => ({ provider: "none", model: "none" }),
      setActive() {},
      getPermissions: () => ({ project: [], global: [] }),
      workflowController,
      getSkills: () =>
        buildSkillRegistry(
          [
            {
              name: "workflow-creator",
              description: "Create workflows",
              body: "host only",
              source: "built-in",
            },
          ],
          [],
        ),
    });
    await registry.get("skill")!.run('workflow-creator "weather"', {
      cwd: "/work",
      print() {},
      runPrompt: async () => {
        ranPrompt = true;
      },
    });
    expect(handled).toEqual(['create "weather"']);
    expect(ranPrompt).toBe(false);
  });
});
