import { describe, expect, it } from "bun:test";
import {
  DEFAULT_PERSONALITY,
  PERSONALITIES,
  completePersonalityLine,
  gatedVoiceCorrection,
  overlayFor,
  personalityInfo,
  resolvePersonalityName,
  resolveStartPersonality,
  voiceCorrectionFor,
  voiceTurnReminder,
} from "../../src/agent/personalities";

describe("PERSONALITIES", () => {
  it("ships neutral, cleetus, bofh in order, each with a description", () => {
    expect(PERSONALITIES.map((p) => p.id)).toEqual(["neutral", "cleetus", "bofh"]);
    for (const p of PERSONALITIES) {
      expect(p.description.trim().length).toBeGreaterThan(0);
    }
  });
  it("defaults to neutral", () => {
    expect(DEFAULT_PERSONALITY).toBe("neutral");
  });
  it("neutral has an empty overlay; the gags do not", () => {
    expect(overlayFor("neutral")).toBe("");
    expect(overlayFor("cleetus").trim().length).toBeGreaterThan(0);
    expect(overlayFor("bofh").trim().length).toBeGreaterThan(0);
  });
});

describe("guardrail clauses are present in the gag overlays", () => {
  it("cleetus is tone-only and never touches code", () => {
    const o = overlayFor("cleetus");
    expect(o).toContain("TONE ONLY");
    expect(o).toContain("ALL user-facing");
    expect(o).toContain("direct answers, summaries");
    expect(o).toContain("NEVER apply it to code");
    expect(o).toContain("Respect the active persona's constraints");
  });
  it("bofh keeps competence, stays non-destructive, and never leaks into code", () => {
    const o = overlayFor("bofh");
    expect(o).toContain("PURE COMEDIC THEATER");
    expect(o).toContain("Competence is non-negotiable");
    expect(o).toContain("never actually perform or trigger destructive");
    expect(o).toContain("Narration only");
    expect(o).toContain("Respect the active persona's constraints");
  });
  it("cleetus is told to vary its phrasing and drop the stock greeting", () => {
    const o = overlayFor("cleetus");
    expect(o).toContain("Vary your folksy phrasing");
    expect(o).toContain("Freshness is the charm");
  });
  it("bofh never names the persona", () => {
    const o = overlayFor("bofh");
    expect(o).toContain("Never refer to yourself");
    expect(o).toContain("BOFH");
  });
});

describe("personalityInfo", () => {
  it("looks up by id", () => {
    expect(personalityInfo("bofh").id).toBe("bofh");
  });
});

describe("voiceTurnReminder", () => {
  it("is empty for neutral and explicit for active voices", () => {
    expect(voiceTurnReminder("neutral")).toBe("");
    expect(voiceTurnReminder("cleetus")).toContain("Active voice: Cleetus");
    expect(voiceTurnReminder("cleetus")).toContain("final user-facing prose");
    expect(voiceTurnReminder("bofh")).toContain("Active voice: Bastard Operator From Hell");
  });
});

describe("gatedVoiceCorrection", () => {
  const blandCleetus = "The forecast was saved to `forecast.json`. The temperature is 77 F.";

  it("returns null when correction is disabled, even for a draft missing the voice", () => {
    expect(gatedVoiceCorrection(false, "cleetus", blandCleetus)).toBeNull();
  });

  it("delegates to voiceCorrectionFor when correction is enabled", () => {
    const gated = gatedVoiceCorrection(true, "cleetus", blandCleetus);
    expect(gated).not.toBeNull();
    expect(gated?.instruction).toBe(voiceCorrectionFor("cleetus", blandCleetus)?.instruction);
  });

  it("still returns null for neutral when enabled", () => {
    expect(gatedVoiceCorrection(true, "neutral", blandCleetus)).toBeNull();
  });
});

describe("voiceCorrectionFor", () => {
  it("requests one prose-only correction for bland active-voice output", () => {
    const correction = voiceCorrectionFor(
      "cleetus",
      "The forecast was saved to `forecast.json`. The temperature is 77 F.",
    );
    expect(correction?.systemPrompt).toContain("Preserve every fact");
    expect(correction?.instruction).toContain("forecast.json");
    expect(correction?.instruction).toContain("one natural Southern expression");
    expect(correction?.instruction).toContain("must visibly change");
    expect(
      correction?.accept("The forecast was saved to `forecast.json`. The temperature is 77 F."),
    ).toBe(false);
    expect(
      correction?.accept(
        "Reckon it is saved to `forecast.json`, with the temperature holding at 77 F.",
      ),
    ).toBe(true);
    expect(correction?.accept("Reckon it is saved to `other.json`, with a high of 79 F.")).toBe(
      false,
    );
  });

  it("does not rewrite neutral, already voiced, short, or stopped output", () => {
    expect(voiceCorrectionFor("neutral", "A long but ordinary final response.")).toBeNull();
    expect(
      voiceCorrectionFor(
        "cleetus",
        "Reckon that does it: the forecast is saved to `forecast.json`.",
      ),
    ).toBeNull();
    expect(voiceCorrectionFor("cleetus", "Done.")).toBeNull();
    expect(voiceCorrectionFor("cleetus", "Stopped: the model server failed.")).toBeNull();
  });

  it("recognizes varied homespun prose without requiring a stock catchphrase", () => {
    expect(
      voiceCorrectionFor(
        "cleetus",
        "Well, pull up a rocker—the forecast has no precipitation in the cards today.",
      ),
    ).toBeNull();
    expect(
      voiceCorrectionFor(
        "cleetus",
        "Zero chance of rain, so the good ol’ clear blue can stay put today.",
      ),
    ).toBeNull();
  });
});

describe("resolvePersonalityName", () => {
  it("matches an exact id", () => {
    expect(resolvePersonalityName("cleetus")).toBe("cleetus");
  });
  it("matches an unambiguous prefix", () => {
    expect(resolvePersonalityName("c")).toBe("cleetus");
    expect(resolvePersonalityName("b")).toBe("bofh");
  });
  it("is case-insensitive and trims", () => {
    expect(resolvePersonalityName("  NEUTRAL ")).toBe("neutral");
  });
  it("returns null for unknown and empty", () => {
    expect(resolvePersonalityName("nope")).toBeNull();
    expect(resolvePersonalityName("")).toBeNull();
  });
});

describe("resolveStartPersonality", () => {
  it("uses the config default when no flag is given", () => {
    expect(resolveStartPersonality("neutral", undefined)).toEqual({
      personality: "neutral",
      warnings: [],
    });
  });
  it("lets a valid flag override the config default", () => {
    expect(resolveStartPersonality("neutral", "bofh")).toEqual({
      personality: "bofh",
      warnings: [],
    });
  });
  it("warns and falls back to the config default on an unknown flag", () => {
    const r = resolveStartPersonality("neutral", "bogus");
    expect(r.personality).toBe("neutral");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/unknown --personality/);
  });
});

describe("completePersonalityLine", () => {
  it("suggests candidates for a partial", () => {
    const out = completePersonalityLine("/personality b");
    expect(out).toEqual([
      { display: "bofh — Bastard Operator From Hell voice", value: "/personality bofh" },
    ]);
  });
  it("returns nothing for a non-personality line", () => {
    expect(completePersonalityLine("/persona c")).toEqual([]);
  });
});
