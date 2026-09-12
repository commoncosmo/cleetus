import { describe, expect, it } from "bun:test";
import { specDraftKeyAction } from "../../../src/ui/tui/spec-draft-prompt";

const plain = { return: false, escape: false };

describe("specDraftKeyAction", () => {
  it("maps enter and a to approve", () => {
    expect(specDraftKeyAction("", { ...plain, return: true })).toBe("approve");
    expect(specDraftKeyAction("a", plain)).toBe("approve");
    expect(specDraftKeyAction("A", plain)).toBe("approve");
  });

  it("maps r to revise", () => {
    expect(specDraftKeyAction("r", plain)).toBe("revise");
    expect(specDraftKeyAction("R", plain)).toBe("revise");
  });

  it("maps s and esc to save (keep the file, stop)", () => {
    expect(specDraftKeyAction("s", plain)).toBe("save");
    expect(specDraftKeyAction("S", plain)).toBe("save");
    expect(specDraftKeyAction("", { ...plain, escape: true })).toBe("save");
  });

  it("maps e to edit", () => {
    expect(specDraftKeyAction("e", plain)).toBe("edit");
    expect(specDraftKeyAction("E", plain)).toBe("edit");
  });

  it("ignores every other key", () => {
    for (const k of ["g", "o", "p", "x", " ", "1"]) {
      expect(specDraftKeyAction(k, plain)).toBeNull();
    }
  });
});
