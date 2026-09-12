import { describe, expect, it } from "bun:test";
import { STRUCTURE_SYSTEM } from "../../src/agent/orchestrator-prompts";
import {
  DEFAULT_PERSONA,
  PERSONAS,
  completePersonaLine,
  personaInfo,
  personaPrompt,
  resolvePersonaName,
  resolveStartPersona,
} from "../../src/agent/personas";
import { estimateTokens } from "../../src/repomap/render";

describe("PERSONAS", () => {
  it("ships coding, chat, concise, general in order, each with non-empty prompt + description", () => {
    expect(PERSONAS.map((p) => p.id)).toEqual(["coding", "chat", "concise", "general"]);
    for (const p of PERSONAS) {
      expect(p.prompt.trim().length).toBeGreaterThan(0);
      expect(p.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("defaults to coding", () => {
    expect(DEFAULT_PERSONA).toBe("coding");
  });

  it("every persona carries the tool-call hygiene directive (valid JSON, no invented params)", () => {
    for (const p of PERSONAS) {
      expect(p.prompt).toContain("valid JSON arguments");
      expect(p.prompt).toContain("never invent parameter names");
    }
  });

  it("every persona asks models to batch known independent tool work", () => {
    for (const persona of PERSONAS) {
      expect(persona.prompt).toContain("one tool-call batch");
      expect(persona.prompt).toContain("separate model round");
    }
  });

  it("every persona carries the narration-discipline directive (sparse narration, no sycophancy)", () => {
    for (const p of PERSONAS) {
      expect(p.prompt).toContain("you're absolutely right");
      expect(p.prompt).toContain("reacting to the tool");
    }
  });

  it("every persona emits rendered Markdown directly instead of fencing whole reports", () => {
    for (const persona of PERSONAS) {
      expect(persona.prompt).toContain("Write user-facing Markdown directly");
      expect(persona.prompt).toContain("Never wrap a complete answer");
      expect(persona.prompt).toContain("renders fenced content literally");
    }
    expect(personaInfo("coding").smallPrompt).toContain("Write user-facing Markdown directly");
  });

  it("the coding persona tells the model to write a .gitignore before the first commit (#136)", () => {
    const coding = PERSONAS.find((p) => p.id === "coding")!;
    expect(coding.prompt).toContain(".gitignore");
    expect(coding.prompt).toContain("before the first");
    // not forced on the chat persona
    expect(PERSONAS.find((p) => p.id === "chat")!.prompt).not.toContain(".gitignore");
  });

  it("the coding persona uses working todos for substantial implementations only", () => {
    const coding = personaInfo("coding");
    for (const prompt of [coding.prompt, coding.smallPrompt!]) {
      expect(prompt).toContain("todo_write");
      expect(prompt).toContain("multi-step implementation");
      expect(prompt).toContain("small focused change");
    }
    expect(personaInfo("chat").prompt).not.toContain("todo_write");
  });

  it("the coding persona answers conversational turns without firing tools (#144)", () => {
    const coding = PERSONAS.find((p) => p.id === "coding")!;
    expect(coding.prompt).toContain("purely conversational");
    expect(coding.prompt).toContain("do not read files, search, or call any tools");
    // not pushed onto the chat persona
    expect(PERSONAS.find((p) => p.id === "chat")!.prompt).not.toContain("purely conversational");
  });

  it("coding persona carries the scaffold-honesty guidance", () => {
    const coding = PERSONAS.find((p) => p.id === "coding");
    expect(coding).toBeDefined();
    expect(coding!.prompt).toContain("scaffold");
    expect(coding!.prompt).toContain("point to the code that implements them");
  });

  it("the coding persona steers scaffolding in-place and prompts a cwd check (#157)", () => {
    const coding = PERSONAS.find((p) => p.id === "coding")!;
    expect(coding.prompt).toContain("nested");
    expect(coding.prompt).toContain("pwd");
    // coding-specific: not pushed onto the chat persona
    expect(PERSONAS.find((p) => p.id === "chat")!.prompt).not.toContain("nested");
  });

  it("the coding persona carries the test-first reflex with a skip clause for non-testable changes", () => {
    const coding = PERSONAS.find((p) => p.id === "coding")!;
    expect(coding.prompt).toContain("test-first");
    expect(coding.prompt).toContain("fails for the right reason");
    expect(coding.prompt).toContain("definition of done");
    expect(coding.prompt).toContain("not meaningfully unit-testable");
    // never forced on the other personas
    expect(PERSONAS.find((p) => p.id === "chat")!.prompt).not.toContain("test-first");
  });
});

describe("personaInfo", () => {
  it("looks up by id", () => {
    expect(personaInfo("chat").id).toBe("chat");
  });
});

describe("resolvePersonaName", () => {
  it("matches an exact id", () => {
    expect(resolvePersonaName("coding")).toBe("coding");
  });
  it("matches an unambiguous prefix", () => {
    expect(resolvePersonaName("ch")).toBe("chat");
  });
  it("is case-insensitive and trims", () => {
    expect(resolvePersonaName("  CONCISE ")).toBe("concise");
  });
  it("returns null for unknown", () => {
    expect(resolvePersonaName("nope")).toBeNull();
  });
  it("returns null for empty", () => {
    expect(resolvePersonaName("")).toBeNull();
  });
});

describe("resolveStartPersona", () => {
  it("uses the config default when no flag is given", () => {
    expect(resolveStartPersona("coding", undefined)).toEqual({ persona: "coding", warnings: [] });
  });
  it("lets a valid flag override the config default", () => {
    expect(resolveStartPersona("coding", "chat")).toEqual({ persona: "chat", warnings: [] });
  });
  it("warns and falls back to the config default on an unknown flag", () => {
    const r = resolveStartPersona("coding", "bogus");
    expect(r.persona).toBe("coding");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/unknown --persona/);
  });
});

describe("completePersonaLine", () => {
  it("completes a /persona partial", () => {
    expect(completePersonaLine("/persona cod")).toEqual([
      {
        display: "coding — Coding agent: completes tasks, summarizes, gives run instructions",
        value: "/persona coding",
      },
    ]);
  });
  it("returns nothing for a non-/persona line", () => {
    expect(completePersonaLine("/route sp")).toEqual([]);
  });
});

describe("general persona", () => {
  it("ships a general persona", () => {
    expect(PERSONAS.map((p) => p.id)).toContain("general");
  });
  it("keeps verify-before-claiming discipline", () => {
    const g = PERSONAS.find((p) => p.id === "general")!;
    expect(g.prompt).toContain("actually ran the tool");
  });
});

describe("coding persona — multi-step completion", () => {
  it("instructs completing every part and verifying before claiming done", () => {
    const prompt = personaInfo("coding").prompt.toLowerCase();
    expect(prompt).toContain("every part");
    expect(prompt).toContain("verify");
  });
});

describe("coding persona — verified handoff", () => {
  it("carries the smoke_run discipline and the ✓/⚠ handoff labels", () => {
    const coding = PERSONAS.find((p) => p.id === "coding")!;
    expect(coding.prompt).toContain("smoke_run");
    expect(coding.prompt).toContain("✓");
    expect(coding.prompt).toContain("⚠");
  });
});

describe("coding persona — non-interactive scaffolding", () => {
  it("guides non-interactive scaffolding and wiring the dev server", () => {
    const coding = PERSONAS.find((p) => p.id === "coding")!;
    expect(coding.prompt).toContain("non-interactive");
    expect(coding.prompt).toContain("beforeDevCommand");
  });
});

describe("coding persona — docs grounding for pinned versions", () => {
  it("guides grounding on current docs for a pinned version", () => {
    const coding = PERSONAS.find((p) => p.id === "coding")!;
    expect(coding.prompt).toContain("current API");
    expect(coding.prompt).toContain("ask the user");
  });
});

describe("over-build guardrail", () => {
  it("the coding persona tells the model to default to terminal output and ask before building a web app", () => {
    const coding = PERSONAS.find((p) => p.id === "coding");
    const text = (coding?.prompt ?? "").toLowerCase();
    expect(text).toContain("terminal");
    expect(text).toContain("web page");
    expect(text).toContain("ask");
  });

  it("the orchestrator structuring prompt forbids turning a display/knowledge request into a web app", () => {
    const s = STRUCTURE_SYSTEM.toLowerCase();
    expect(s).toContain("web page");
    expect(s).toContain("terminal");
  });
});

describe("personaPrompt (capability variant)", () => {
  it("coding + small returns the distilled prompt", () => {
    const small = personaPrompt("coding", "small");
    expect(small).toBe(personaInfo("coding").smallPrompt!);
    expect(small).not.toBe(personaInfo("coding").prompt);
  });
  it("coding + standard returns the full prompt", () => {
    expect(personaPrompt("coding", "standard")).toBe(personaInfo("coding").prompt);
  });
  it("personas without a smallPrompt fall back regardless of capability", () => {
    expect(personaPrompt("chat", "small")).toBe(personaInfo("chat").prompt);
    expect(personaPrompt("concise", "small")).toBe(personaInfo("concise").prompt);
  });
  it("the distilled coding prompt is materially smaller and keeps the hygiene rule", () => {
    const small = personaInfo("coding").smallPrompt!;
    expect(estimateTokens(small)).toBeLessThan(500);
    expect(small).toContain("never invent parameter names");
    // must not point at tools the small roster hides:
    expect(small).not.toContain("smoke_run");
    expect(small).not.toContain("web_search");
    expect(small).not.toContain("web_fetch");
  });
});
