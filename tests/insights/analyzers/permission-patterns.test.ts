import { expect, test } from "bun:test";
import { analyzePermissionPatterns } from "../../../src/insights/analyzers/permission-patterns";
import type { PermissionSummary, Trajectory } from "../../../src/insights/trajectory";

function traj(permissions: PermissionSummary[]): Trajectory {
  return {
    sessionId: "s",
    startTs: 0,
    endTs: 0,
    userInput: "",
    taskClass: "conversation",
    modelCalls: [],
    toolCalls: [],
    permissions,
    loopCount: 0,
    outcome: "ok",
    incomplete: false,
  };
}
const allow = (summary: string): PermissionSummary => ({
  tool: "bash",
  argsSummary: summary,
  decision: "allow",
});
const deny = (summary: string): PermissionSummary => ({
  tool: "bash",
  argsSummary: summary,
  decision: "deny",
});

test("suggests an always-allowed (>=5, zero denies) pattern", () => {
  const r = analyzePermissionPatterns([
    traj(Array.from({ length: 6 }, () => allow("bash: git status"))),
  ]);
  expect(r.stats).toEqual([
    { tool: "bash", argsSummary: "bash: git status", allows: 6, denies: 0 },
  ]);
  expect(r.suggestions).toHaveLength(1);
  expect(r.suggestions[0]).toMatchObject({
    tool: "bash",
    argsSummary: "bash: git status",
    allows: 6,
  });
});

test("a single deny suppresses the suggestion", () => {
  const r = analyzePermissionPatterns([
    traj([...Array.from({ length: 6 }, () => allow("bash: rm -rf")), deny("bash: rm -rf")]),
  ]);
  expect(r.suggestions).toEqual([]);
});

test("below threshold yields no suggestion", () => {
  const r = analyzePermissionPatterns([traj([allow("bash: ls"), allow("bash: ls")])]);
  expect(r.suggestions).toEqual([]);
});

test("aggregates the same (tool,args) across multiple trajectories", () => {
  const r = analyzePermissionPatterns([
    traj([allow("bash: git status"), allow("bash: git status"), allow("bash: git status")]),
    traj([allow("bash: git status"), allow("bash: git status")]),
  ]);
  expect(r.stats).toEqual([
    { tool: "bash", argsSummary: "bash: git status", allows: 5, denies: 0 },
  ]);
  expect(r.suggestions).toHaveLength(1);
});

test("counts different tools with the same argsSummary as separate, sorted stats", () => {
  const r = analyzePermissionPatterns([
    traj([
      { tool: "write_file", argsSummary: "foo", decision: "allow" },
      { tool: "read_file", argsSummary: "foo", decision: "allow" },
    ]),
  ]);
  expect(r.stats).toEqual([
    { tool: "read_file", argsSummary: "foo", allows: 1, denies: 0 },
    { tool: "write_file", argsSummary: "foo", allows: 1, denies: 0 },
  ]);
});
