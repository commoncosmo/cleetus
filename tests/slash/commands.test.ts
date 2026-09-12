import { beforeEach, describe, expect, it } from "bun:test";
import type { PersonalityId } from "../../src/agent/personalities";
import type { PermissionRules } from "../../src/permission/types";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import { buildCommandRegistry } from "../../src/slash/commands";

class FakeProvider implements Provider {
  constructor(private readonly models: string[] = ["alpha", "beta"]) {}
  async listModels() {
    return this.models.map((id) => ({ id }));
  }
  async *chat(): AsyncIterable<StreamEvent> {
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

describe("slash commands", () => {
  let providers: ProviderRegistry;
  let printed: string[];
  let activeProvider = "p1";
  let activeModel = "alpha";
  const rules: PermissionRules = {
    project: [{ tool: "bash", argsPattern: "git status*", decision: "allow" }],
    global: [],
  };
  const ctx = () => ({
    cwd: "/tmp",
    print: (s: string) => {
      printed.push(s);
    },
  });

  beforeEach(() => {
    providers = new ProviderRegistry();
    providers.register("p1", new FakeProvider());
    printed = [];
  });

  it("/model switches to a model that exists on the provider", async () => {
    activeProvider = "p1";
    activeModel = "alpha";
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: (p, m) => {
        activeProvider = p;
        activeModel = m;
      },
      getPermissions: () => rules,
    });
    await reg.get("model")!.run("beta", ctx());
    expect(activeModel).toBe("beta");
    expect(printed.join("\n")).toContain("active model: beta");
  });

  it("/model rejects an unknown model and leaves the active model unchanged", async () => {
    activeProvider = "p1";
    activeModel = "alpha";
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: (p, m) => {
        activeProvider = p;
        activeModel = m;
      },
      getPermissions: () => rules,
    });
    await reg.get("model")!.run("does-not-exist", ctx());
    expect(activeModel).toBe("alpha");
    const text = printed.join("\n");
    expect(text).toContain("not found");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });

  it("/model with no argument prints the current model", async () => {
    activeProvider = "p1";
    activeModel = "alpha";
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
    });
    await reg.get("model")!.run("", ctx());
    expect(printed.join("\n")).toContain("active model: alpha");
  });

  it("/model with no args opens the picker via onShowModels, without printing", async () => {
    let opened = false;
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: "p1", model: "alpha" }),
      setActive: () => {},
      getPermissions: () => rules,
      onShowModels: () => {
        opened = true;
      },
    });
    await reg.get("model")!.run("", ctx());
    expect(opened).toBe(true);
    expect(printed).toHaveLength(0);
  });

  it("/models command no longer exists", () => {
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
    });
    expect(reg.get("models")).toBeUndefined();
  });

  it("/sessions lists project session IDs and marks the active session", async () => {
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
      getSessionId: () => "CURRENT",
      getSessions: () => [
        { id: "CURRENT", model: "alpha", preview: "active task", createdAt: 2 },
        { id: "OLDER", model: "beta", preview: "older task", createdAt: 1 },
      ],
    });

    await reg.get("sessions")!.run("", ctx());

    expect(reg.get("session")).toBe(reg.get("sessions"));
    expect(printed.join("\n")).toContain("* CURRENT · alpha · active task");
    expect(printed.join("\n")).toContain("  OLDER · beta · older task");
    expect(printed.join("\n")).toContain("cleetus --resume <session-id>");
  });

  it("/model resolves a model unique to one provider and switches provider", async () => {
    const multi = new ProviderRegistry();
    multi.register("p1", new FakeProvider(["alpha", "beta"]));
    multi.register("p2", new FakeProvider(["beta", "gamma"]));
    let ap = "p1";
    let am = "alpha";
    const reg = buildCommandRegistry({
      providers: multi,
      getActive: () => ({ provider: ap, model: am }),
      setActive: (p, m) => {
        ap = p;
        am = m;
      },
      getPermissions: () => rules,
    });
    await reg.get("model")!.run("gamma", ctx());
    expect(ap).toBe("p2");
    expect(am).toBe("gamma");
  });

  it("/model reports ambiguity for a model on multiple providers and leaves it unchanged", async () => {
    const multi = new ProviderRegistry();
    multi.register("p1", new FakeProvider(["alpha", "beta"]));
    multi.register("p2", new FakeProvider(["beta", "gamma"]));
    let ap = "p1";
    let am = "alpha";
    const reg = buildCommandRegistry({
      providers: multi,
      getActive: () => ({ provider: ap, model: am }),
      setActive: (p, m) => {
        ap = p;
        am = m;
      },
      getPermissions: () => rules,
    });
    await reg.get("model")!.run("beta", ctx());
    expect(printed.join("\n")).toContain("multiple providers");
    expect(am).toBe("alpha");
  });

  it("/model <provider> <model> disambiguates a shared model name", async () => {
    const multi = new ProviderRegistry();
    multi.register("p1", new FakeProvider(["alpha", "beta"]));
    multi.register("p2", new FakeProvider(["beta", "gamma"]));
    let ap = "p1";
    let am = "alpha";
    const reg = buildCommandRegistry({
      providers: multi,
      getActive: () => ({ provider: ap, model: am }),
      setActive: (p, m) => {
        ap = p;
        am = m;
      },
      getPermissions: () => rules,
    });
    await reg.get("model")!.run("p2 beta", ctx());
    expect(ap).toBe("p2");
    expect(am).toBe("beta");
  });

  it("/permissions prints current rules", async () => {
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
    });
    await reg.get("permissions")!.run("", ctx());
    const text = printed.join("\n");
    expect(text).toContain("git status*");
  });

  it("/instructions prints the resolved instruction text", async () => {
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
      getInstructions: () => "BE NICE",
    });
    await reg.get("instructions")!.run("", ctx());
    expect(printed.join("\n")).toContain("BE NICE");
  });

  it("/instructions prints fallback when no instructions", async () => {
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
      getInstructions: () => "",
    });
    await reg.get("instructions")!.run("", ctx());
    expect(printed.join("\n")).toContain("(no instruction files found)");
  });

  it("/quit resolves to the exit command via alias", async () => {
    let exited = false;
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
      onExit: () => {
        exited = true;
      },
    });
    expect(reg.get("quit")).toBe(reg.get("exit"));
    await reg.get("quit")!.run("", ctx());
    expect(exited).toBe(true);
  });

  it("/help lists the exit command's alias", async () => {
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
    });
    await reg.get("help")!.run("", ctx());
    expect(printed.join("\n")).toContain("/quit");
  });

  it("/mode normal applies immediately", async () => {
    let mode = "fuckit";
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
      getMode: () => mode as "normal" | "fuckit",
      setMode: (m) => {
        mode = m;
      },
    });
    await reg.get("mode")!.run("normal", ctx());
    expect(mode).toBe("normal");
    expect(printed.join("\n")).toContain("permission mode: normal");
  });

  it("/mode fuckit routes through the picker (confirmation) instead of applying", async () => {
    let mode = "normal";
    let shown = "";
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
      getMode: () => mode as "normal" | "fuckit",
      setMode: (m) => {
        mode = m;
      },
      onShowMode: (initial) => {
        shown = initial ?? "called";
      },
    });
    await reg.get("mode")!.run("fuckit", ctx());
    // never applied directly; opens the picker pre-targeted at fuckit
    expect(mode).toBe("normal");
    expect(shown).toBe("fuckit");
  });

  it("/mode opens the picker when given no args", async () => {
    let opened = false;
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
      getMode: () => "normal",
      setMode: () => {},
      onShowMode: () => {
        opened = true;
      },
    });
    await reg.get("mode")!.run("", ctx());
    expect(opened).toBe(true);
  });

  it("/mode with no picker prints the current mode and options", async () => {
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
      getMode: () => "normal",
      setMode: () => {},
    });
    await reg.get("mode")!.run("", ctx());
    const text = printed.join("\n");
    expect(text).toContain("* normal");
    expect(text).toContain("fuckit");
  });

  it("/mode rejects an unknown mode", async () => {
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => rules,
      getMode: () => "normal",
      setMode: () => {},
      onShowMode: () => {},
    });
    await reg.get("mode")!.run("bogus", ctx());
    expect(printed.join("\n")).toContain("unknown mode");
  });

  it("/allow pushes rule into in-memory permissions", async () => {
    const liveRules: import("../../src/permission/types").PermissionRules = {
      project: [],
      global: [],
    };
    const tmpPath = `${require("node:os").tmpdir()}/cleetus-test-perms-${Date.now()}.yaml`;
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: () => {},
      getPermissions: () => liveRules,
      projectPermissionsPath: tmpPath,
    });
    await reg.get("allow")!.run("bash:git*", ctx());
    expect(liveRules.project).toHaveLength(1);
    expect(liveRules.project[0]).toMatchObject({
      tool: "bash",
      argsPattern: "git*",
      decision: "allow",
    });
  });

  it("/personality switches to a valid personality", async () => {
    let applied: PersonalityId | null = null;
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: (p, m) => {
        activeProvider = p;
        activeModel = m;
      },
      getPermissions: () => rules,
      getPersonality: () => "neutral",
      setPersonality: (id) => {
        applied = id;
      },
    });
    await reg.get("personality")!.run("bofh", ctx());
    expect(applied!).toBe("bofh");
    expect(printed.join("\n")).toContain("personality: bofh");
  });

  it("/personality rejects an unknown personality", async () => {
    const reg = buildCommandRegistry({
      providers,
      getActive: () => ({ provider: activeProvider, model: activeModel }),
      setActive: (p, m) => {
        activeProvider = p;
        activeModel = m;
      },
      getPermissions: () => rules,
      getPersonality: () => "neutral",
      setPersonality: () => {},
    });
    await reg.get("personality")!.run("bogus", ctx());
    expect(printed.join("\n")).toContain("unknown personality 'bogus'");
  });

  describe("/orchestrate", () => {
    let orchestrationEnabled: boolean;

    const makeReg = () => {
      orchestrationEnabled = false;
      return buildCommandRegistry({
        providers,
        getActive: () => ({ provider: activeProvider, model: activeModel }),
        setActive: () => {},
        getPermissions: () => rules,
        getOrchestrationEnabled: () => orchestrationEnabled,
        setOrchestrationEnabled: (v: boolean) => {
          orchestrationEnabled = v;
        },
      });
    };

    it("bare run prints current state (off)", async () => {
      const reg = makeReg();
      await reg.get("orchestrate")!.run("", ctx());
      expect(printed.join("\n")).toContain("orchestration: off");
    });

    it("'on' enables orchestration", async () => {
      const reg = makeReg();
      await reg.get("orchestrate")!.run("on", ctx());
      expect(orchestrationEnabled).toBe(true);
      expect(printed.join("\n")).toContain("orchestration: on");
    });

    it("'off' disables orchestration", async () => {
      const reg = makeReg();
      orchestrationEnabled = true;
      await reg.get("orchestrate")!.run("off", ctx());
      expect(orchestrationEnabled).toBe(false);
      expect(printed.join("\n")).toContain("orchestration: off");
    });

    it("'toggle' flips the flag", async () => {
      const reg = makeReg();
      await reg.get("orchestrate")!.run("toggle", ctx());
      expect(orchestrationEnabled).toBe(true);
      expect(printed.join("\n")).toContain("orchestration: on");
      printed = [];
      await reg.get("orchestrate")!.run("toggle", ctx());
      expect(orchestrationEnabled).toBe(false);
      expect(printed.join("\n")).toContain("orchestration: off");
    });

    it("is hidden when setOrchestrationEnabled is absent", () => {
      const reg = buildCommandRegistry({
        providers,
        getActive: () => ({ provider: activeProvider, model: activeModel }),
        setActive: () => {},
        getPermissions: () => rules,
      });
      expect(reg.get("orchestrate")).toBeUndefined();
    });

    it("unknown arg prints usage and leaves flag unchanged", async () => {
      const reg = makeReg();
      await reg.get("orchestrate")!.run("banana", ctx());
      const text = printed.join("\n").toLowerCase();
      expect(text).toContain("usage");
      expect(orchestrationEnabled).toBe(false);
    });
  });
});
