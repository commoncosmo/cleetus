import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpCommandHandler } from "../../src/acp/commands";
import type { LearnPlaybookController } from "../../src/learn/service";
import { MemoryStore } from "../../src/memory/store";
import { stripSystemReminders } from "../../src/skills/compose";
import { buildSkillRegistry } from "../../src/skills/registry";
import type { Skill } from "../../src/skills/types";

const skills: Skill[] = [
  {
    name: "weather-lookup",
    description: "Look up and summarize a forecast",
    source: "project",
    body: "Follow the reliable weather procedure.",
  },
  {
    name: "test-driven-development",
    description: "Use a red-green-refactor loop",
    source: "built-in",
    body: "Write the failing test first.",
  },
];

function handler() {
  return createAcpCommandHandler(buildSkillRegistry(skills, []));
}

function learnHarness() {
  const calls: string[] = [];
  const controllers = new Map<string, LearnPlaybookController>();
  const forSession = (sessionId: string): LearnPlaybookController => {
    const existing = controllers.get(sessionId);
    if (existing) return existing;
    let pending = false;
    const controller: LearnPlaybookController = {
      propose: async (signal) => {
        calls.push(`propose:${sessionId}:${signal ? "signal" : "no-signal"}`);
        pending = true;
        return `draft for ${sessionId}`;
      },
      save: async (scope) => {
        calls.push(`save:${sessionId}:${scope}`);
        pending = false;
        return `saved ${scope} for ${sessionId}`;
      },
      discard: () => {
        calls.push(`discard:${sessionId}`);
        pending = false;
        return `discarded for ${sessionId}`;
      },
      status: () => (pending ? `pending for ${sessionId}` : `empty for ${sessionId}`),
    };
    controllers.set(sessionId, controller);
    return controller;
  };
  return {
    calls,
    handler: createAcpCommandHandler(buildSkillRegistry(skills, []), {
      learnPlaybookForSession: forSession,
    }),
  };
}

function fullHarness() {
  const calls: string[] = [];
  const registry = buildSkillRegistry(
    [
      ...skills,
      {
        name: "spec-creator",
        description: "Create a specification",
        source: "built-in",
        body: "Work with the user to create a specification.",
      },
    ],
    [],
  );
  return {
    calls,
    handler: createAcpCommandHandler(registry, {
      buildSpecSeed: (idea) => `SPEC(${idea})`,
      clearSession: (sessionId) => {
        calls.push(`clear:${sessionId}`);
      },
      compactSession: async (sessionId, instruction) => {
        calls.push(`compact:${sessionId}:${instruction ?? ""}`);
        return {
          compacted: true,
          messagesFolded: 4,
          beforeTokens: 10_200,
          afterTokens: 3_100,
          partial: false,
        };
      },
    }),
  };
}

describe("ACP slash commands", () => {
  it("advertises only the commands it can execute", () => {
    expect(handler().availableCommands()).toEqual([
      {
        name: "skill",
        description: "Run a skill playbook, or list available skills",
        input: { hint: "<name> [arguments]" },
      },
    ]);
  });

  it("advertises /learn only when a learned-playbook controller is wired", () => {
    expect(learnHarness().handler.availableCommands()).toEqual([
      {
        name: "skill",
        description: "Run a skill playbook, or list available skills",
        input: { hint: "<name> [arguments]" },
      },
      {
        name: "learn",
        description: "Draft or refine a playbook from the previous turn",
        input: { hint: "[status|discard|save project|save global]" },
      },
    ]);
  });

  it("advertises /spec, /clear, and /compact only when their services are wired", () => {
    expect(fullHarness().handler.availableCommands()).toEqual([
      {
        name: "skill",
        description: "Run a skill playbook, or list available skills",
        input: { hint: "<name> [arguments]" },
      },
      {
        name: "spec",
        description: "Draft a specification interactively",
        input: { hint: "[rough idea]" },
      },
      {
        name: "clear",
        description: "Clear the conversation context",
      },
      {
        name: "compact",
        description: "Summarize the conversation to shrink its context",
        input: { hint: "[instruction]" },
      },
    ]);
  });

  it("lists skills without invoking the model for bare /skill", async () => {
    const result = await handler().execute("/skill", { sessionId: "one" });
    expect(result?.kind).toBe("text");
    if (result?.kind !== "text") throw new Error("expected text result");
    expect(result.text).toContain("weather-lookup — Look up and summarize a forecast");
    expect(result.text).toContain("type /skill <name> to run one");
  });

  it("composes an exact or unambiguous-prefix skill invocation as an agent turn", async () => {
    const exact = await handler().execute("/skill weather-lookup Wilmette tomorrow", {
      sessionId: "one",
    });
    expect(exact?.kind).toBe("agent-turn");
    if (exact?.kind !== "agent-turn") throw new Error("expected agent turn");
    // The visible line is the command as typed; the playbook rides inside a reminder (#316).
    expect(stripSystemReminders(exact.prompt)).toBe("/skill weather-lookup Wilmette tomorrow");
    expect(exact.prompt).toContain("Follow the reliable weather procedure.");
    expect(exact.prompt).toContain("User request / arguments: Wilmette tomorrow");

    const prefix = await handler().execute("/skill test add a parser", { sessionId: "one" });
    expect(prefix?.kind).toBe("agent-turn");
    if (prefix?.kind !== "agent-turn") throw new Error("expected agent turn");
    expect(prefix.prompt).toContain("Write the failing test first.");
    expect(prefix.prompt).toContain("User request / arguments: add a parser");
  });

  it("returns a useful local error for an unknown skill", async () => {
    expect(await handler().execute("/skill missing", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "unknown skill 'missing'. available: test-driven-development, weather-lookup",
    });
  });

  it("executes the full /learn lifecycle against a session-isolated controller", async () => {
    const harness = learnHarness();
    const signal = new AbortController().signal;
    expect(await harness.handler.execute("/learn", { sessionId: "one", signal })).toEqual({
      kind: "text",
      text: "draft for one",
    });
    expect(await harness.handler.execute("/learn status", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "pending for one",
    });
    expect(await harness.handler.execute("/learn status", { sessionId: "two" })).toEqual({
      kind: "text",
      text: "empty for two",
    });
    expect(await harness.handler.execute("/learn save project", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "saved project for one",
    });
    expect(await harness.handler.execute("/learn discard", { sessionId: "two" })).toEqual({
      kind: "text",
      text: "discarded for two",
    });
    expect(harness.calls).toEqual(["propose:one:signal", "save:one:project", "discard:two"]);
  });

  it("returns /learn usage without touching the controller for invalid arguments", async () => {
    const harness = learnHarness();
    expect(await harness.handler.execute("/learn save anywhere", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "usage: /learn save project|global",
    });
    expect(await harness.handler.execute("/learn wat", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "usage: /learn [draft|status|discard|save project|save global]",
    });
    expect(harness.calls).toEqual([]);
  });

  it("turns /spec into a seeded agent turn", async () => {
    expect(
      await fullHarness().handler.execute("/spec an offline notes app", {
        sessionId: "one",
      }),
    ).toEqual({
      kind: "agent-turn",
      prompt: "SPEC(an offline notes app)",
    });
  });

  it("clears and compacts the addressed ACP session without invoking the model", async () => {
    const harness = fullHarness();
    expect(await harness.handler.execute("/clear", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "context cleared",
    });
    expect(
      await harness.handler.execute("/compact retain API decisions", { sessionId: "one" }),
    ).toEqual({
      kind: "text",
      text: "Compacted 4 messages: ~10k → ~3k tokens (-70%).",
    });
    expect(harness.calls).toEqual(["clear:one", "compact:one:retain API decisions"]);
  });

  it("reports compact no-op and rejects arguments to /clear", async () => {
    const noOp = createAcpCommandHandler(buildSkillRegistry(skills, []), {
      clearSession: () => {},
      compactSession: async () => ({
        compacted: false,
        messagesFolded: 0,
        beforeTokens: 100,
        afterTokens: 100,
        partial: false,
      }),
    });
    expect(await noOp.execute("/clear now", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "usage: /clear",
    });
    expect(await noOp.execute("/compact", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "Nothing to compact yet — context is already small.",
    });
  });

  it("exposes instructions, durable memory, permissions, and live MCP status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-acp-commands-"));
    try {
      const global = new MemoryStore(join(dir, "global.md"));
      const project = new MemoryStore(join(dir, "project.md"));
      let maxLoops = Number.POSITIVE_INFINITY;
      global.add("Prefer Bun.");
      project.add("The API entrypoint is src/api.ts.");
      const supported = createAcpCommandHandler(buildSkillRegistry(skills, []), {
        getInstructions: () => "Follow AGENTS.md.",
        memory: { global, project },
        getPermissions: async () => ({
          project: [
            { tool: "bash", argsPattern: "bun test*", decision: "allow" },
            {
              tool: "job_start",
              decision: "allow",
              jobKindPattern: "sast.*",
              jobEffect: "read",
              jobTargetPattern: "repo:*",
              maxTimeoutMs: 60_000,
              maxOutputBytes: 1_048_576,
              maxArtifactBytes: 10_485_760,
            },
          ],
          global: [{ tool: "git_push", decision: "ask" }],
        }),
        getMcpStatus: () => [
          {
            name: "docs",
            state: "connected",
            toolCount: 2,
            toolNames: ["search", "read"],
          },
        ],
        getMaxLoops: () => maxLoops,
        setMaxLoops: (_sessionId, value) => {
          maxLoops = value;
        },
      });

      expect(supported.availableCommands().map((command) => command.name)).toEqual([
        "skill",
        "instructions",
        "memory",
        "permissions",
        "mcp",
        "maxloops",
      ]);
      expect(await supported.execute("/instructions", { sessionId: "one" })).toEqual({
        kind: "text",
        text: "Follow AGENTS.md.",
      });
      expect(await supported.execute("/memory", { sessionId: "one" })).toEqual({
        kind: "text",
        text: "Global:\n  1. Prefer Bun.\nProject:\n  2. The API entrypoint is src/api.ts.",
      });
      expect(
        await supported.execute("/memory add Use focused tests first.", {
          sessionId: "one",
        }),
      ).toEqual({
        kind: "text",
        text: `remembered (project) → ${join(dir, "project.md")}: Use focused tests first.`,
      });
      expect(project.list()).toEqual([
        "The API entrypoint is src/api.ts.",
        "Use focused tests first.",
      ]);
      expect(await supported.execute("/memory forget 1", { sessionId: "one" })).toEqual({
        kind: "text",
        text: "forgot (global) 1: Prefer Bun.",
      });
      expect(await supported.execute("/permissions", { sessionId: "one" })).toEqual({
        kind: "text",
        text: "project:\n  bash bun test* -> allow\n  job_start * [kind=sast.*, effect=read, target=repo:*, timeout<=60000ms, output<=1048576B, artifacts<=10485760B] -> allow\nglobal:\n  git_push * -> ask",
      });
      expect(await supported.execute("/mcp", { sessionId: "one" })).toEqual({
        kind: "text",
        text: "docs — connected (2 tools)\n    search\n    read",
      });
      expect(await supported.execute("/maxloops", { sessionId: "one" })).toEqual({
        kind: "text",
        text: "model-round limit: unlimited",
      });
      expect(await supported.execute("/maxloops 40", { sessionId: "one" })).toEqual({
        kind: "text",
        text: "model-round limit: 40",
      });
      expect(maxLoops).toBe(40);
      expect(await supported.execute("/maxloops unlimited", { sessionId: "one" })).toEqual({
        kind: "text",
        text: "model-round limit: unlimited",
      });
      expect(maxLoops).toBe(Number.POSITIVE_INFINITY);
      expect(await supported.execute("/maxloops nope", { sessionId: "one" })).toEqual({
        kind: "text",
        text: "invalid limit 'nope' — use a positive integer or 'unlimited'",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists and applies session-scoped rewind checkpoints", async () => {
    const calls: string[] = [];
    const supported = createAcpCommandHandler(buildSkillRegistry(skills, []), {
      getCheckpoints: (sessionId) =>
        sessionId === "one"
          ? [
              { turnNumber: 2, userInput: "edit the parser", ts: 1 },
              { turnNumber: 3, userInput: "add tests", ts: 2 },
            ]
          : [],
      rewindToCheckpoint: async (sessionId, turnNumber) => {
        calls.push(`${sessionId}:${turnNumber}`);
        return true;
      },
    });

    expect(supported.availableCommands().at(-1)?.name).toBe("rewind");
    expect(await supported.execute("/rewind", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "2  edit the parser\n3  add tests",
    });
    expect(await supported.execute("/rewind 3", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "rewound to checkpoint #3",
    });
    expect(calls).toEqual(["one:3"]);
    expect(await supported.execute("/rewind 4", { sessionId: "one" })).toEqual({
      kind: "text",
      text: "no checkpoint #4 (available: 2, 3)",
    });
    expect(await supported.execute("/rewind", { sessionId: "two" })).toEqual({
      kind: "text",
      text: "nothing to rewind to",
    });
  });

  it("runs insights, review, and indexing without sending slash syntax to the model", async () => {
    const calls: string[] = [];
    const supported = createAcpCommandHandler(buildSkillRegistry(skills, []), {
      runInsights: async (sessionId, args, signal) => {
        calls.push(`insights:${sessionId}:${args}:${signal ? "signal" : "none"}`);
        return "session report";
      },
      runReview: async (sessionId, args, signal) => {
        calls.push(`review:${sessionId}:${args}:${signal ? "signal" : "none"}`);
        return undefined;
      },
      runIndex: async (sessionId, args, signal) => {
        calls.push(`index:${sessionId}:${args}:${signal ? "signal" : "none"}`);
        return "indexed project";
      },
    });
    const signal = new AbortController().signal;

    expect(
      supported
        .availableCommands()
        .slice(-3)
        .map((command) => command.name),
    ).toEqual(["insights", "review", "index"]);
    expect(
      await supported.execute("/insights since 7d explain", { sessionId: "one", signal }),
    ).toEqual({ kind: "text", text: "session report" });
    expect(
      await supported.execute("/review src/acp/commands.ts", { sessionId: "one", signal }),
    ).toEqual({ kind: "handled" });
    expect(await supported.execute("/index rebuild", { sessionId: "one", signal })).toEqual({
      kind: "text",
      text: "indexed project",
    });
    expect(calls).toEqual([
      "insights:one:since 7d explain:signal",
      "review:one:src/acp/commands.ts:signal",
      "index:one:rebuild:signal",
    ]);
  });

  it("leaves prose and commands without a wired implementation to the normal prompt path", async () => {
    expect(await handler().execute("please use a skill", { sessionId: "one" })).toBeNull();
    expect(await handler().execute("/learn", { sessionId: "one" })).toBeNull();
  });
});
