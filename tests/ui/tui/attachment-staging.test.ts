import { expect, test } from "bun:test";
import { takeStaged } from "../../../src/ui/tui/staged-buffer";
import { stagedIndicator } from "../../../src/ui/tui/staged-indicator";

test("stagedIndicator renders a count or nothing", () => {
  expect(stagedIndicator(0)).toBeNull();
  expect(stagedIndicator(2)).toContain("2 images");
  expect(stagedIndicator(1)).toContain("1 image ");
});

test("takeStaged snapshots then clears synchronously — a second same-tick call sees empty", () => {
  const box = { current: ["a.png", "b.png"] };
  expect(takeStaged(box)).toEqual(["a.png", "b.png"]);
  // The box itself is now empty — a second read in the same tick (no `await` in between,
  // mirroring runPrompt's stagedImagesRef snapshot-and-clear) must not re-see the same items.
  expect(box.current).toEqual([]);
  expect(takeStaged(box)).toEqual([]);
});
