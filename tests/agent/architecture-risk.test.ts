import { describe, expect, it } from "bun:test";
import {
  architectureResolutionPrompt,
  copiedStatefulControllerRisk,
  findCopiedStatefulControllerRisk,
} from "../../src/agent/architecture-risk";

describe("stateful controller architecture risk", () => {
  it("does not mistake page copy for copying a controller", () => {
    const text =
      "Each product page is its own default-exported component under `src/pages/` with its own mascot, copy, and badge — distinct content, so **no shared controller/composition seam is required** (there's no behavior to preserve across presentations, only navigation, which the router shell owns).";
    expect(findCopiedStatefulControllerRisk(text)).toBeNull();
    expect(
      findCopiedStatefulControllerRisk(
        "Each page has a mascot, copy, and badge; duplicate the controller handlers in both components.",
      ),
    ).not.toBeNull();
  });
  it("returns the offending active design instruction", () => {
    const text =
      "Implementation plan:\n1. Copy the inline state block and all handlers from App into AltApp.\n2. Wire AltApp into the bin.";
    const risk = findCopiedStatefulControllerRisk(text);
    expect(risk?.evidence).toContain("Copy the inline state block");
    expect(copiedStatefulControllerRisk(text)).toContain("Offending plan text");
  });

  it("ignores negations, rejected alternatives, and explanatory prose", () => {
    for (const text of [
      "Calls useCleetusApp(props) — the same hook, no controller copy.",
      "No useState or handler is duplicated.",
      "There is one controller and zero duplicated state or handlers.",
      "The naive approach copies controller state and would be a behavior fork.",
      "Neither skin duplicates the completion or controller behavior.",
      "That duplicates the controller.",
      "Why not a second App copy: that would fork 40 useState/useRef hooks and every handler — a behavior fork explicitly forbidden by the spec.",
    ]) {
      expect(findCopiedStatefulControllerRisk(text)).toBeNull();
    }
  });

  it("inherits prohibition context from a Markdown heading", () => {
    for (const heading of [
      "## What this plan deliberately does NOT do",
      "## Out of scope",
      "## Non-goals",
      "## Rejected alternatives",
    ]) {
      expect(
        findCopiedStatefulControllerRisk(
          `${heading}\n- Copy any state/ref/effect/handler/registration into a layout. Both layouts consume the shared controller.`,
        ),
      ).toBeNull();
    }
  });

  it("accepts the codex5 Option C replacement plan's negative architecture section", () => {
    const text = `
## Why this resolves the architecture guard
There is exactly one App component and one useAppController call site.

## What this plan deliberately does NOT do
- Create an AltApp component.
- Allow any layout to call useAppController, useState, useRef, useEffect, or useInput.
- Copy any state/ref/effect/handler/registration into a layout. Both layouts consume c.

## Spec open questions — resolved
- The alt skin inherits the default keybindings.`;
    expect(findCopiedStatefulControllerRisk(text)).toBeNull();
  });

  it("resumes active detection at the next same-level heading", () => {
    const text = `
## What this plan deliberately does NOT do
- Copy controller state into a layout.
### Rejected example
- Duplicate the handlers in AltApp.

## Implementation steps
1. Copy the inline state block and all handlers from App into AltApp.
2. Wire AltApp into the bin.`;
    const risk = findCopiedStatefulControllerRisk(text);
    expect(risk?.evidence).toContain("Copy the inline state block");
  });

  it("asks for bounded options and a recommendation before another plan", () => {
    const prompt = architectureResolutionPrompt("bad seam");
    expect(prompt).toContain("2-3 mutually exclusive");
    expect(prompt).toContain("Recommend one option");
    expect(prompt).toContain("Do not emit another implementation plan yet");
    expect(prompt).toContain("bad seam");
  });
});
