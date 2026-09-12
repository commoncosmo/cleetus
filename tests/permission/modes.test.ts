import { describe, expect, it } from "bun:test";
import {
  MODES,
  completeModeLine,
  modeFromDisabled,
  modeInfo,
  nextPriorMode,
  resolveModeName,
} from "../../src/permission/modes";

describe("nextPriorMode", () => {
  it("captures the current mode when entering plan from a non-plan mode", () => {
    expect(nextPriorMode("normal", "plan", "normal")).toBe("normal");
    expect(nextPriorMode("fuckit", "plan", "normal")).toBe("fuckit");
  });

  it("preserves the remembered prior mode when re-entering plan while already in plan", () => {
    // The bug: this used to overwrite priorMode with "plan", so approving a plan (which restores
    // priorMode) became a no-op and the session was stuck in plan mode forever.
    expect(nextPriorMode("plan", "plan", "normal")).toBe("normal");
  });

  it("leaves the prior mode unchanged when switching to a non-plan mode", () => {
    expect(nextPriorMode("plan", "normal", "normal")).toBe("normal");
    expect(nextPriorMode("normal", "fuckit", "normal")).toBe("normal");
  });
});

describe("modeFromDisabled", () => {
  it("maps the disabled boolean to a mode id", () => {
    expect(modeFromDisabled(false)).toBe("normal");
    expect(modeFromDisabled(true)).toBe("fuckit");
  });
});

describe("modeInfo", () => {
  it("flags fuckit as dangerous and normal as not", () => {
    expect(modeInfo("fuckit").dangerous).toBe(true);
    expect(modeInfo("normal").dangerous).toBeUndefined();
  });
});

describe("resolveModeName", () => {
  it("resolves exact ids", () => {
    expect(resolveModeName("normal")).toBe("normal");
    expect(resolveModeName("fuckit")).toBe("fuckit");
  });
  it("resolves unambiguous prefixes, case-insensitively", () => {
    expect(resolveModeName("norm")).toBe("normal");
    expect(resolveModeName("FUCK")).toBe("fuckit");
    expect(resolveModeName("f")).toBe("fuckit");
  });
  it("returns null for empty or unknown input", () => {
    expect(resolveModeName("")).toBeNull();
    expect(resolveModeName("  ")).toBeNull();
    expect(resolveModeName("bogus")).toBeNull();
  });
});

describe("completeModeLine", () => {
  it("returns nothing unless the line is a /mode line", () => {
    expect(completeModeLine("/model gpt")).toEqual([]);
    expect(completeModeLine("hello")).toEqual([]);
  });
  it("lists all modes with descriptions for a bare /mode<space>", () => {
    const out = completeModeLine("/mode ");
    expect(out.map((c) => c.value)).toEqual(["/mode normal", "/mode fuckit", "/mode plan"]);
    expect(out[0]!.display).toContain("—");
  });
  it("filters by the typed partial", () => {
    const out = completeModeLine("/mode fu");
    expect(out.map((c) => c.value)).toEqual(["/mode fuckit"]);
  });
});

describe("MODES", () => {
  it("contains exactly normal, fuckit, and plan", () => {
    expect(MODES.map((m) => m.id)).toEqual(["normal", "fuckit", "plan"]);
  });
});

describe("plan mode", () => {
  it("plan is a known mode", () => {
    expect(MODES.map((m) => m.id)).toContain("plan");
    expect(modeInfo("plan").id).toBe("plan");
    expect(modeInfo("plan").dangerous).toBeFalsy();
  });

  it("resolveModeName resolves 'plan' and the prefix 'pl'", () => {
    expect(resolveModeName("plan")).toBe("plan");
    expect(resolveModeName("pl")).toBe("plan");
  });

  it("completeModeLine offers plan", () => {
    const vals = completeModeLine("/mode pl").map((c) => c.value);
    expect(vals).toContain("/mode plan");
  });
});
