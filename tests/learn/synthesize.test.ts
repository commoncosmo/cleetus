import { describe, expect, it } from "bun:test";
import { synthesizePlaybook } from "../../src/learn/synthesize";
import type { LearnableTurn } from "../../src/learn/types";
import type { ChatOptions, ModelInfo, Provider, StreamEvent } from "../../src/providers/types";
import { triggeredSkills } from "../../src/skills/trigger";
import type { Skill } from "../../src/skills/types";

const turn: LearnableTurn = {
  sessionId: "s1",
  startTs: 10,
  endTs: 20,
  userInput: "Look up the Wilmette weather forecast and save the JSON",
  assistantText: "Saved it.",
  invokedSkillNames: [],
  steps: [
    {
      name: "web_fetch",
      args: { url: "https://api.weather.gov/points/42,-87" },
      ok: true,
      output: '{"forecast":"https://api.weather.gov/gridpoints/LOT/1,2/forecast"}',
    },
    {
      name: "save_fetched_json",
      args: {
        url: "https://api.weather.gov/gridpoints/LOT/1,2/forecast",
        path: "forecast.json",
      },
      ok: true,
      output: "saved exact cached JSON",
    },
  ],
};

class FakeProvider implements Provider {
  calls: ChatOptions[] = [];
  constructor(
    private readonly response: string,
    private readonly rejectStructured = false,
    private readonly finishReason: "stop" | "tool-calls" | "length" | "error" = "stop",
  ) {}
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
  async *chat(opts: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push(opts);
    if (this.rejectStructured && opts.responseFormat) {
      throw new Error("chat request failed (400) unknown field: response_format");
    }
    yield { type: "text-delta", text: this.response };
    yield {
      type: "finish",
      reason: this.finishReason,
      usage: { input: 120, output: 40 },
      model: "served-m",
    };
  }
  async embed(): Promise<number[]> {
    return [];
  }
}

function response(body?: string): string {
  return JSON.stringify({
    name: "US Weather Retrieval",
    description: "Retrieve authoritative US weather forecasts and exact JSON artifacts.",
    triggers: ["weather forecast", "Wilmette", "unrelated deployment"],
    body:
      body ??
      "## When to use\nFor weather forecasts.\n\n## Procedure\nUse `web_fetch` against https://api.weather.gov and preserve the successful sequence.\n\n## Avoid\nDo not copy large JSON manually.\n\n## Success checks\nConfirm `save_fetched_json` succeeds.",
  });
}

describe("synthesizePlaybook", () => {
  it("returns a normalized, grounded draft with narrow triggers", async () => {
    const provider = new FakeProvider(response());
    const draft = await synthesizePlaybook({ provider, model: "m", turn });

    expect(draft.name).toBe("us-weather-retrieval");
    expect(draft.triggers).toEqual(["weather", "weather forecast", "Wilmette"]);
    expect(
      triggeredSkills(
        [
          {
            name: draft.name,
            description: draft.description,
            source: "project",
            body: draft.body,
            trigger: { when: [], match: draft.triggers },
          },
        ],
        "What's the weather looking like for Wilmette, IL?",
      ).map((skill) => skill.name),
    ).toEqual(["us-weather-retrieval"]);
    expect(draft.source.sessionId).toBe("s1");
    expect(provider.calls[0]!.responseFormat?.name).toBe("learned_playbook");
    expect(provider.calls[0]!.maxOutputTokens).toBe(4_096);
    expect(provider.calls[0]!.messages[0]!.content).toContain("qualifiers already present");
    expect(provider.calls[0]!.messages[0]!.content).toContain("Do not require an extra lookup");
    expect(provider.calls[0]!.messages[0]!.content).toContain(
      "single-word, distinctive intent noun",
    );
  });

  it("retries without constrained output when the provider rejects response_format", async () => {
    const provider = new FakeProvider(response(), true);
    const draft = await synthesizePlaybook({ provider, model: "m", turn });

    expect(draft.name).toBe("us-weather-retrieval");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]!.responseFormat).toBeDefined();
    expect(provider.calls[1]!.responseFormat).toBeUndefined();
  });

  it("treats other invoked skills as context and asks for only residual knowledge", async () => {
    const provider = new FakeProvider(response());
    const supportingSkill: Skill = {
      name: "test-driven-development",
      description: "Drive testable coding changes through red, green, and refactor.",
      source: "built-in",
      body: "Write a failing test, make it pass, then refactor.",
      trigger: { when: ["coding-task"], match: [] },
    };
    const repeatedTurn: LearnableTurn = {
      ...turn,
      steps: [{ ...turn.steps[0]!, repeatCount: 3 }, turn.steps[1]!],
    };

    await synthesizePlaybook({
      provider,
      model: "m",
      turn: repeatedTurn,
      supportingSkills: [supportingSkill],
    });

    expect(provider.calls[0]!.messages[0]!.content).toContain("distinct, reusable residual");
    expect(provider.calls[0]!.messages[0]!.content).toContain("not refinement targets");
    expect(provider.calls[0]!.messages[1]!.content).toContain("test-driven-development (built-in)");
    expect(provider.calls[0]!.messages[1]!.content).toContain("3 adjacent equivalent attempts");
  });

  it("reports finish metadata from the completion that produced the draft", async () => {
    const provider = new FakeProvider(response());
    let finish:
      | {
          finishReason: string;
          usage?: { input?: number; output?: number };
          servedModel?: string;
        }
      | undefined;

    await synthesizePlaybook({
      provider,
      model: "m",
      turn,
      onFinish: (value) => {
        finish = value;
      },
    });

    expect(finish).toEqual({
      finishReason: "stop",
      usage: { input: 120, output: 40 },
      servedModel: "served-m",
    });
  });

  it("revises an invoked learned skill without changing its identity", async () => {
    const existing: Skill = {
      name: "open-meteo-weather-fetch",
      description: "Retrieve weather with Open-Meteo.",
      source: "global",
      body: "## When to use\nWeather.\n\n## Procedure\nFetch https://api.weather.gov.\n\n## Avoid\nGuessing.\n\n## Success checks\nCheck it.",
      trigger: { when: [], match: ["weather forecast", "blocked weather websites"] },
      learned: { sourceSessions: ["old"], revision: 1 },
    };
    const provider = new FakeProvider(
      JSON.stringify({
        name: "a-new-specialized-sibling",
        description: "Retrieve weather with a more robust lookup.",
        triggers: ["weather forecast", "blocked weather websites"],
        body: "## When to use\nWeather.\n\n## Procedure\nFetch https://api.weather.gov and verify the returned region.\n\n## Avoid\nGuessing.\n\n## Success checks\nCheck the region.",
      }),
    );

    const draft = await synthesizePlaybook({
      provider,
      model: "m",
      turn,
      existingSkill: existing,
    });

    expect(draft.name).toBe("open-meteo-weather-fetch");
    expect(draft.triggers).toEqual(["weather", "weather forecast", "blocked weather websites"]);
    expect(provider.calls[0]!.messages[0]!.content).toContain("complete revised");
    expect(provider.calls[0]!.messages[0]!.content).toContain("same playbook");
    expect(provider.calls[0]!.messages[1]!.content).toContain("Existing learned playbook name");
    expect(provider.calls[0]!.maxOutputTokens).toBe(4_096);
    expect(provider.calls[0]!.temperature).toBe(0.1);
  });

  it("reports a bounded, actionable failure when reasoning consumes the revision ceiling", async () => {
    const existing: Skill = {
      name: "weather-retrieval",
      description: "Retrieve weather.",
      source: "global",
      body: "## When to use\nWeather.\n\n## Procedure\nFetch https://api.weather.gov.\n\n## Avoid\nGuessing.\n\n## Success checks\nCheck it.",
      trigger: { when: [], match: ["weather forecast"] },
      learned: { sourceSessions: ["old"], revision: 1 },
    };
    const provider = new FakeProvider(response(), false, "length");
    let finishReason: string | undefined;

    await expect(
      synthesizePlaybook({
        provider,
        model: "m",
        turn,
        existingSkill: existing,
        onFinish: (value) => {
          finishReason = value?.finishReason;
        },
      }),
    ).rejects.toThrow("4,096-token output ceiling");
    expect(finishReason).toBe("length");
  });

  it("gives new drafts enough generated-token room for reasoning before structured output", async () => {
    const provider = new FakeProvider(response(), false, "length");

    await expect(synthesizePlaybook({ provider, model: "m", turn })).rejects.toThrow(
      "draft reached its 4,096-token output ceiling",
    );
    expect(provider.calls[0]!.maxOutputTokens).toBe(4_096);
  });

  it("rejects a source origin that was not observed in the trace", async () => {
    const provider = new FakeProvider(
      response(
        "## When to use\nWeather.\n\n## Procedure\nFetch https://invented.example/api.\n\n## Avoid\nGuessing.\n\n## Success checks\nInspect it.",
      ),
    );
    expect(synthesizePlaybook({ provider, model: "m", turn })).rejects.toThrow(
      "introduced an unobserved source",
    );
  });

  it("rejects generic action and output words as the only possible intent anchor", async () => {
    const provider = new FakeProvider(
      JSON.stringify({
        name: "file-output-helper",
        description: "Create and save output files.",
        triggers: ["create file", "save output"],
        body: "## When to use\nFiles.\n\n## Procedure\nWrite one.\n\n## Avoid\nGuessing.\n\n## Success checks\nCheck it.",
      }),
    );
    await expect(synthesizePlaybook({ provider, model: "m", turn })).rejects.toThrow(
      "no distinctive reusable intent anchor",
    );
  });
});
