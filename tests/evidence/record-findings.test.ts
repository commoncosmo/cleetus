import { describe, expect, it } from "bun:test";
import { EvidenceRegistry, RecordFindingsTool, parseEvidenceBundle } from "../../src/evidence";

function evidenceBundle(title = "Investigation") {
  const parsed = parseEvidenceBundle({
    schemaVersion: 1,
    bundleId: "case-42",
    title,
    items: [
      {
        id: "access-log",
        kind: "web_server_log",
        uri: "ccsec://cases/42/access.jsonl",
        redaction: "applied",
        provenance: { source: "nginx export" },
      },
    ],
  });
  if (!parsed.ok) throw new Error("invalid test evidence bundle");
  return parsed.value;
}

function findingSet(evidenceId = "access-log") {
  return {
    schemaVersion: 1,
    findingSetId: "findings-42",
    evidenceBundleId: "case-42",
    findings: [
      {
        id: "finding-1",
        summary: "A suspicious request reached the legacy route",
        status: "confirmed",
        severity: "medium",
        confidence: "high",
        evidence: [{ evidenceId, locator: { kind: "line", value: "184" } }],
        affected: ["GET /legacy"],
        preconditions: ["The legacy route is enabled"],
      },
    ],
  };
}

describe("EvidenceRegistry", () => {
  it("accepts an idempotent bundle registration but rejects identity reuse", () => {
    const registry = new EvidenceRegistry();
    expect(registry.registerBundles("session-1", [evidenceBundle()])).toEqual([]);
    expect(registry.registerBundles("session-1", [evidenceBundle()])).toEqual([]);
    expect(registry.registerBundles("session-1", [evidenceBundle("Changed title")])).toEqual([
      expect.objectContaining({
        path: "bundleId.case-42",
        message: expect.stringContaining("different evidence bundle"),
      }),
    ]);
  });

  it("keeps bundle identity isolated by ACP session", () => {
    const registry = new EvidenceRegistry();
    expect(registry.registerBundles("session-1", [evidenceBundle()])).toEqual([]);
    expect(registry.bundle("session-1", "case-42")).toBeDefined();
    expect(registry.bundle("session-2", "case-42")).toBeUndefined();
  });
});

describe("RecordFindingsTool", () => {
  it("records a validated set and returns standard ACP-ready structured content", async () => {
    const registry = new EvidenceRegistry();
    registry.registerBundles("session-1", [evidenceBundle()]);
    const tool = new RecordFindingsTool(registry);
    const result = await tool.run(
      { finding_set: findingSet() },
      {
        projectDir: "/project",
        sessionId: "session-1",
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("1 structured finding");
    expect(result.structuredContent).toEqual({
      type: "finding_set",
      value: expect.objectContaining({ findingSetId: "findings-42" }),
    });
    expect(registry.findingSet("session-1", "findings-42")).toBeDefined();
  });

  it("rejects unknown evidence references without recording a partial set", async () => {
    const registry = new EvidenceRegistry();
    registry.registerBundles("session-1", [evidenceBundle()]);
    const result = await new RecordFindingsTool(registry).run(
      { finding_set: findingSet("missing-evidence") },
      {
        projectDir: "/project",
        sessionId: "session-1",
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("unknown evidence id 'missing-evidence'");
    expect(registry.findingSet("session-1", "findings-42")).toBeUndefined();
  });

  it("requires the evidence bundle to be registered in the active session", async () => {
    const result = await new RecordFindingsTool(new EvidenceRegistry()).run(
      { finding_set: findingSet() },
      {
        projectDir: "/project",
        sessionId: "session-1",
        abortSignal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("is not registered for this session");
  });
});
