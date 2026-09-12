import { describe, expect, it } from "bun:test";
import { type ActiveAcpSessionHolder, createAcpSessionConfig } from "../../src/acp/session-config";

function harness(
  withTiers = true,
  onActiveChange?: (choice: { provider: string; model: string }) => void,
) {
  const holder: ActiveAcpSessionHolder = { current: null };
  const controller = createAcpSessionConfig({
    defaults: {
      active: { provider: "ollama", model: "qwen" },
      persona: "coding",
      personality: "cleetus",
      effort: "medium",
      route: withTiers ? "smart" : "manual",
      maxToolLoops: Number.POSITIVE_INFINITY,
    },
    catalog: [
      { provider: "ollama", models: ["qwen", "gpt-oss"] },
      { provider: "lmstudio", models: ["granite"] },
      { provider: "offline", models: [], error: "unreachable" },
    ],
    routingTiersAvailable: withTiers,
    holder,
    onActiveChange,
  });
  return { holder, controller };
}

describe("ACP session configuration", () => {
  it("advertises stable select options with ACP semantic categories", () => {
    const { controller } = harness();
    const options = controller.options("one");
    expect(options.map((option) => option.id)).toEqual([
      "provider",
      "model",
      "persona",
      "personality",
      "effort",
      "route",
    ]);
    expect(options.find((option) => option.id === "model")).toMatchObject({
      category: "model",
      type: "select",
      currentValue: "qwen",
    });
    expect(options.find((option) => option.id === "effort")?.category).toBe("thought_level");
    expect(
      options.find((option) => option.id === "provider")?.options.map((option) => option.value),
    ).toEqual(["ollama", "lmstudio"]);
  });

  it("keeps settings independent between sessions and selects the active turn's state", () => {
    const { holder, controller } = harness();
    controller.set("one", "personality", "bofh");
    controller.set("two", "personality", "neutral");

    holder.current = "one";
    expect(controller.current().personality).toBe("bofh");
    holder.current = "two";
    expect(controller.current().personality).toBe("neutral");
    holder.current = null;
    expect(controller.current().personality).toBe("cleetus");
  });

  it("refreshes the model choices and picks a valid model when provider changes", () => {
    const { controller } = harness();
    const options = controller.set("one", "provider", "lmstudio");
    expect(controller.ensure("one").active).toEqual({
      provider: "lmstudio",
      model: "granite",
    });
    expect(options.find((option) => option.id === "model")).toMatchObject({
      currentValue: "granite",
      options: [{ value: "granite", name: "granite" }],
    });
  });

  it("notifies context priming when the active provider or model changes", () => {
    const changed: { provider: string; model: string }[] = [];
    const { controller } = harness(true, (choice) => changed.push(choice));

    controller.set("one", "model", "gpt-oss");
    controller.set("one", "provider", "lmstudio");
    controller.set("one", "effort", "high");

    expect(changed).toEqual([
      { provider: "ollama", model: "gpt-oss" },
      { provider: "lmstudio", model: "granite" },
    ]);
  });

  it("does not advertise unusable routed modes without configured tiers", () => {
    const { controller } = harness(false);
    expect(
      controller
        .options("one")
        .find((option) => option.id === "route")
        ?.options.map((option) => option.value),
    ).toEqual(["manual"]);
  });

  it("rejects unknown options and values without mutating state", () => {
    const { controller } = harness();
    expect(() => controller.set("one", "effort", "extreme")).toThrow("invalid value 'extreme'");
    expect(() => controller.set("one", "missing", "x")).toThrow(
      "unknown session configuration 'missing'",
    );
    expect(controller.ensure("one").effort).toBe("medium");
  });
});
