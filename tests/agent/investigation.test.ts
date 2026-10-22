import { describe, expect, it } from "bun:test";
import {
  InvestigationGuard,
  investigationToolSurface,
  isCodeInvestigation,
} from "../../src/agent/investigation";

describe("source investigations", () => {
  it("recognizes a focused source review without treating implementation as read-only", () => {
    expect(
      isCodeInvestigation(
        "Take a look at context management in cleetus. Any room for improvement?",
      ),
    ).toBe(true);
    expect(isCodeInvestigation("Implement the suggested fixes")).toBe(false);
    expect(isCodeInvestigation("Review this code and fix the bugs")).toBe(false);
    expect(isCodeInvestigation("Review context management. Do not edit files.")).toBe(true);
    expect(isCodeInvestigation("Look at the context management and recommend improvements")).toBe(
      true,
    );
  });

  it("withholds browser schemas for source reviews but keeps them for browser investigations", () => {
    const tools = [
      { name: "read_file" },
      { name: "mcp__playwright__browser_snapshot" },
      { name: "mcp__db__query" },
    ];
    expect(
      investigationToolSurface(tools, "Review context management code").map((t) => t.name),
    ).toEqual(["read_file", "mcp__db__query"]);
    expect(investigationToolSurface(tools, "Review browser rendering code")).toEqual(tools);
    expect(investigationToolSurface(tools, "Implement context improvements")).toEqual(tools);
  });

  it("checkpoints repeated evidence across cat, numbered reads, and overlapping sed ranges", () => {
    const guard = new InvestigationGuard();
    const lines = Array.from({ length: 60 }, (_, i) => `const symbol${i} = ${i};`);
    expect(guard.observe("read_file", { ok: true, output: lines.join("\n") })).toBeNull();
    let action: string | null = null;
    for (let i = 0; i < 8; i++) {
      action = guard.observe("bash", {
        ok: true,
        output: lines
          .slice(i, 55)
          .map((line, n) => `${n + i + 1}\t${line}`)
          .join("\n"),
      });
      if (action === "finish") break;
    }
    expect(action).toBe("finish");
  });

  it("does not checkpoint new evidence, short outputs, or a useful sequence of reads", () => {
    const guard = new InvestigationGuard();
    for (let i = 0; i < 30; i++) {
      expect(
        guard.observe("read_file", {
          ok: true,
          output: Array.from(
            { length: 30 },
            (_, j) => `function newEvidence${i}_${j}() { return ${i}; }`,
          ).join("\n"),
        }),
      ).toBeNull();
      expect(guard.observe("bash", { ok: true, output: "ok" })).toBeNull();
    }
  });

  it("treats a new substantive line in an overlapping read as new evidence", () => {
    const guard = new InvestigationGuard();
    const shared = Array.from({ length: 40 }, (_, i) => `const original${i} = ${i};`).join("\n");
    for (let i = 0; i < 10; i++) {
      expect(
        guard.observe("read_file", { ok: true, output: `${shared}\nconst newFinding${i} = true;` }),
      ).toBeNull();
    }
  });
});
