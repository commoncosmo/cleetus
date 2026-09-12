import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventSource } from "../../src/events/log";
import type { Event, EventInput, EventType } from "../../src/events/types";
import { savePlaybook } from "../../src/learn/persist";
import { LearnPlaybookService } from "../../src/learn/service";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, ModelInfo, Provider, StreamEvent } from "../../src/providers/types";
import { buildSkillRegistry } from "../../src/skills/registry";
import { triggeredSkills } from "../../src/skills/trigger";

function event(type: EventType, payload: unknown, ts: number): Event {
  return { id: `e-${ts}`, sessionId: "s1", type, payload, ts };
}

const events: Event[] = [
  event("user_input", { text: "Fetch the Wilmette weather forecast" }, 1),
  event(
    "tool_call_request",
    {
      call: {
        id: "fetch",
        name: "web_fetch",
        args: { url: "https://api.weather.gov/points/42,-87" },
      },
    },
    2,
  ),
  event(
    "tool_call_end",
    {
      call: { id: "fetch", name: "web_fetch" },
      ok: true,
      output: '{"forecast":"https://api.weather.gov/gridpoints/LOT/1,2/forecast"}',
    },
    3,
  ),
  event("assistant_message", { text: "Forecast retrieved." }, 4),
];

class FakeProvider implements Provider {
  calls: ChatOptions[] = [];
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
  async *chat(opts: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    yield {
      type: "text-delta",
      text: JSON.stringify({
        name: "weather-retrieval",
        description: "Retrieve authoritative US weather forecasts.",
        triggers: ["weather forecast"],
        body: "## When to use\nWeather.\n\n## Procedure\nFetch https://api.weather.gov.\n\n## Avoid\nGuessing.\n\n## Success checks\nConfirm the fetch succeeds.",
      }),
    };
    yield {
      type: "finish",
      reason: "stop",
      usage: { input: 120, output: 40 },
      model: "served-m",
    };
  }
  async embed(): Promise<number[]> {
    return [];
  }
}

function service(root: string) {
  const providers = new ProviderRegistry();
  providers.register("p", new FakeProvider());
  const skills = buildSkillRegistry([], []);
  const logged: EventInput[] = [];
  const source: EventSource = {
    listSessions: () => ["s1"],
    query: () => events,
  };
  return {
    skills,
    logged,
    controller: new LearnPlaybookService({
      events: source,
      eventSink: {
        append(input) {
          logged.push(input);
          return event(input.type, input.payload, 100 + logged.length);
        },
      },
      getSessionId: () => "s1",
      providers,
      getActive: () => ({ provider: "p", model: "m" }),
      skills,
      projectDir: root,
      globalDir: join(root, "global"),
      skillsEnabled: true,
      autoInvoke: true,
    }),
  };
}

describe("LearnPlaybookService", () => {
  it("holds a reviewable draft, saves it, and activates it in the live registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-service-"));
    const { controller, skills, logged } = service(root);

    const draft = await controller.propose();
    expect(draft).toContain("Nothing has been written yet");
    expect(draft).toContain("Literal auto-triggers: weather, weather forecast");
    expect(draft).toContain("case-insensitive literal phrase matching");
    expect(controller.status()).toContain("weather-retrieval");
    expect(logged.map((entry) => entry.type)).toEqual(["model_call_start", "model_call_end"]);
    expect(logged[1]!.payload).toMatchObject({
      model: "served-m",
      reason: "stop",
      usage: { input: 120, output: 40 },
      operation: "learn: playbook draft",
      outcome: "ok",
    });

    const saved = await controller.save("project");
    expect(saved).toContain(join(root, ".cleetus", "skills", "weather-retrieval.md"));
    expect(saved).toContain("active now");
    expect(controller.status()).toContain("no pending");
    expect(
      triggeredSkills(skills.list(), "What's the weather looking like in Wilmette?").map(
        (skill) => skill.name,
      ),
    ).toEqual(["weather-retrieval"]);
  });

  it("does not overwrite an existing named skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-service-"));
    const { controller, skills } = service(root);
    await controller.propose();
    skills.upsert({
      name: "weather-retrieval",
      description: "existing",
      source: "built-in",
      body: "existing",
    });

    expect(await controller.save("global")).toContain("Nothing was overwritten");
    expect(controller.status()).toContain("weather-retrieval");
  });

  it("honors cancellation without leaving a pending draft", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-service-"));
    const { controller } = service(root);
    const ac = new AbortController();
    ac.abort();

    expect(await controller.propose(ac.signal)).toContain("cancelled");
    expect(controller.status()).toContain("no pending");
  });

  it("creates a residual playbook when built-in and user-authored supporting skills were invoked", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-service-"));
    const providers = new ProviderRegistry();
    const provider = new FakeProvider();
    providers.register("p", provider);
    const tdd = {
      name: "test-driven-development",
      description: "Drive testable coding changes through red, green, and refactor.",
      source: "built-in" as const,
      body: "Write a failing test, make it pass, then refactor.",
      trigger: { when: ["coding-task"], match: [] },
    };
    const scaffold = {
      name: "app-scaffolding",
      description: "Scaffold a new application from a template.",
      source: "project" as const,
      body: "Choose a template and run its generator.",
      filePath: join(root, "SKILL.md"),
      trigger: { when: [], match: ["scaffold"] },
    };
    const skills = buildSkillRegistry([tdd], [scaffold]);
    const supportingEvents = [
      events[0]!,
      event(
        "notice",
        {
          kind: "skill_auto_invoked",
          skills: ["test-driven-development", "app-scaffolding"],
          text: "auto-invoked skills: test-driven-development, app-scaffolding",
        },
        1.5,
      ),
      ...events.slice(1),
    ];
    const controller = new LearnPlaybookService({
      events: { listSessions: () => ["s1"], query: () => supportingEvents },
      getSessionId: () => "s1",
      providers,
      getActive: () => ({ provider: "p", model: "m" }),
      skills,
      projectDir: root,
      globalDir: join(root, "global"),
      skillsEnabled: true,
      autoInvoke: true,
    });

    const proposal = await controller.propose();
    expect(proposal).toContain("Learned playbook draft: weather-retrieval");
    expect(proposal).toContain(
      "Supporting skills considered (not refinement targets): test-driven-development, app-scaffolding",
    );
    expect(provider.calls[0]!.messages[0]!.content).toContain("distinct, reusable residual");
    expect(provider.calls[0]!.messages[1]!.content).toContain("test-driven-development (built-in)");
    expect(provider.calls[0]!.messages[1]!.content).toContain("app-scaffolding (project)");
  });

  it("proposes and explicitly saves a revision to the one invoked learned playbook", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-service-"));
    const original = await savePlaybook(
      {
        name: "weather-retrieval",
        description: "Retrieve weather.",
        triggers: ["weather forecast"],
        body: "## When to use\nWeather.\n\n## Procedure\nFetch https://api.weather.gov.\n\n## Avoid\nGuessing.\n\n## Success checks\nConfirm the fetch.",
        source: {
          sessionId: "old-session",
          startTs: 1,
          endTs: 2,
          userInput: "weather",
        },
      },
      {
        scope: "global",
        projectDir: root,
        globalDir: join(root, "global"),
        now: 10,
      },
    );
    const providers = new ProviderRegistry();
    providers.register("p", new FakeProvider());
    const tdd = {
      name: "test-driven-development",
      description: "Drive testable coding changes through red, green, and refactor.",
      source: "built-in" as const,
      body: "Write a failing test, make it pass, then refactor.",
      trigger: { when: ["coding-task"], match: [] },
    };
    const skills = buildSkillRegistry([tdd], [original.skill]);
    const revisionEvents = [
      events[0]!,
      event(
        "notice",
        {
          kind: "skill_auto_invoked",
          skills: ["test-driven-development", "weather-retrieval"],
          text: "auto-invoked skills: test-driven-development, weather-retrieval",
        },
        1.5,
      ),
      ...events.slice(1),
    ];
    const controller = new LearnPlaybookService({
      events: { listSessions: () => ["s1"], query: () => revisionEvents },
      getSessionId: () => "s1",
      providers,
      getActive: () => ({ provider: "p", model: "m" }),
      skills,
      projectDir: root,
      globalDir: join(root, "global"),
      skillsEnabled: true,
      autoInvoke: true,
    });

    const proposal = await controller.propose();
    expect(proposal).toContain("Proposed update to learned playbook: weather-retrieval");
    expect(proposal).toContain(
      "Supporting skills considered (not refinement targets): test-driven-development",
    );
    expect(proposal).toContain("Change summary:");
    expect(proposal).toContain("/learn save global");
    const result = await controller.save("global");
    expect(result).toContain("Previous revision backed up");
    expect(result).toContain(`${original.path}.bak-`);
    const backupPath = /backed up to (\S+)\./.exec(result)?.[1];
    expect(backupPath).toBeDefined();
    expect(existsSync(backupPath!)).toBe(true);
    expect(readFileSync(original.path, "utf8")).toContain(
      "Retrieve authoritative US weather forecasts.",
    );
    expect(skills.get("weather-retrieval")?.learned?.revision).toBe(2);
  });

  it("refuses to guess when multiple skills were auto-invoked", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-service-"));
    const providers = new ProviderRegistry();
    providers.register("p", new FakeProvider());
    const skills = buildSkillRegistry(
      [],
      ["weather-one", "weather-two"].map((name) => ({
        name,
        description: name,
        source: "global" as const,
        body: "Weather.",
        filePath: join(root, `${name}.md`),
        learned: { sourceSessions: ["old"], revision: 1 },
      })),
    );
    const ambiguousEvents = [
      events[0]!,
      event("notice", { kind: "skill_auto_invoked", skills: ["weather-one", "weather-two"] }, 1.5),
      ...events.slice(1),
    ];
    const controller = new LearnPlaybookService({
      events: { listSessions: () => ["s1"], query: () => ambiguousEvents },
      getSessionId: () => "s1",
      providers,
      getActive: () => ({ provider: "p", model: "m" }),
      skills,
      projectDir: root,
      globalDir: join(root, "global"),
      skillsEnabled: true,
      autoInvoke: true,
    });

    expect(await controller.propose()).toContain("matched multiple learned playbooks");
    expect(controller.status()).toContain("no pending");
  });
});
