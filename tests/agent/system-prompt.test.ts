import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../../src/agent/system-prompt";

describe("buildSystemPrompt", () => {
  it("orders instructions and persona first, with the voice overlay last", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "OVERLAY",
      environment: "",
      instructions: "INSTR",
      repoMap: "",
      skills: "",
      memories: "MEM",
    });
    expect(out).toBe("INSTR\n\nPERSONA\n\nMEM\n\nOVERLAY");
  });

  it("places user instructions before the persona (highest prominence)", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "OVERLAY",
      environment: "ENV",
      instructions: "INSTR",
      repoMap: "",
      skills: "",
      memories: "",
    });
    expect(out.indexOf("INSTR")).toBeLessThan(out.indexOf("PERSONA"));
    expect(out).toBe("INSTR\n\nPERSONA\n\nENV\n\nOVERLAY");
  });

  it("places the overlay after the persona when no context fragments follow", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "OVERLAY",
      environment: "",
      instructions: "",
      repoMap: "",
      skills: "",
      memories: "",
    });
    expect(out).toBe("PERSONA\n\nOVERLAY");
  });

  it("drops an empty overlay so neutral is identical to no personality", () => {
    const withNeutral = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "",
      environment: "",
      instructions: "INSTR",
      repoMap: "",
      skills: "",
      memories: "MEM",
    });
    expect(withNeutral).toBe("INSTR\n\nPERSONA\n\nMEM");
  });

  it("drops every empty fragment", () => {
    expect(
      buildSystemPrompt({
        personaPrompt: "PERSONA",
        overlay: "",
        environment: "",
        instructions: "",
        repoMap: "",
        skills: "",
        memories: "",
      }),
    ).toBe("PERSONA");
  });

  it("places the repo-map after the persona, before memories", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "",
      environment: "",
      instructions: "INSTRUCTIONS",
      repoMap: "## Repository map\nx.ts",
      skills: "",
      memories: "MEMORIES",
    });
    expect(out).toBe("INSTRUCTIONS\n\nPERSONA\n\n## Repository map\nx.ts\n\nMEMORIES");
  });

  it("drops an empty repo-map fragment", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "",
      environment: "",
      instructions: "INSTRUCTIONS",
      repoMap: "",
      skills: "",
      memories: "",
    });
    expect(out).toBe("INSTRUCTIONS\n\nPERSONA");
  });

  it("places the skills hint between the repo-map and memories", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "",
      environment: "",
      instructions: "INSTR",
      repoMap: "MAP",
      skills: "SKILLS",
      memories: "MEM",
    });
    expect(out).toBe("INSTR\n\nPERSONA\n\nMAP\n\nSKILLS\n\nMEM");
  });

  it("drops an empty skills fragment", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "",
      environment: "",
      instructions: "INSTR",
      repoMap: "",
      skills: "",
      memories: "",
    });
    expect(out).toBe("INSTR\n\nPERSONA");
  });

  it("places the environment before the final voice overlay", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "OVERLAY",
      environment: "ENV",
      instructions: "",
      repoMap: "",
      skills: "",
      memories: "",
    });
    expect(out).toBe("PERSONA\n\nENV\n\nOVERLAY");
  });

  it("keeps the voice overlay after large recency-sensitive context fragments", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "OVERLAY",
      environment: "ENV",
      instructions: "INSTR",
      repoMap: "MAP",
      skills: "SKILLS",
      memories: "MEM",
    });
    expect(out).toBe("INSTR\n\nPERSONA\n\nENV\n\nMAP\n\nSKILLS\n\nMEM\n\nOVERLAY");
  });

  it("drops an empty environment fragment", () => {
    const out = buildSystemPrompt({
      personaPrompt: "PERSONA",
      overlay: "",
      environment: "",
      instructions: "INSTR",
      repoMap: "",
      skills: "",
      memories: "",
    });
    expect(out).toBe("INSTR\n\nPERSONA");
  });
});
