import { describe, expect, it } from "bun:test";
import { MAX_SARIF_RESULTS, normalizeSarif } from "../../src/evidence";

function sarif() {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "Example Scanner",
            version: "1.2.3",
            rules: [
              {
                id: "SEC001",
                defaultConfiguration: { level: "warning" },
                properties: { "security-severity": "9.4", precision: "high" },
                help: { text: "Use a parameterized query." },
              },
            ],
          },
        },
        results: [
          {
            ruleId: "SEC001",
            ruleIndex: 0,
            partialFingerprints: { primaryLocationLineHash: "abc123" },
            message: { text: "Untrusted input reaches a SQL query" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/db.ts", uriBaseId: "%SRCROOT%" },
                  region: { startLine: 42, startColumn: 7 },
                },
                logicalLocations: [{ fullyQualifiedName: "lookupUser" }],
              },
            ],
          },
          {
            ruleId: "STYLE001",
            level: "note",
            message: { markdown: "Suppressed **style** result" },
            suppressions: [{ kind: "external" }],
          },
        ],
      },
    ],
  };
}

describe("normalizeSarif", () => {
  it("maps SARIF results into stable evidence-backed scanner hypotheses", () => {
    const first = normalizeSarif({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "semgrep-sarif",
      sarif: sarif(),
    });
    const second = normalizeSarif({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "semgrep-sarif",
      sarif: sarif(),
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toEqual(second.value);
    expect(first.value.findings).toHaveLength(2);
    expect(first.value.findings[0]).toMatchObject({
      id: expect.stringMatching(/^sarif-[a-f0-9]{32}$/),
      summary: "Untrusted input reaches a SQL query",
      status: "hypothesis",
      severity: "critical",
      confidence: "high",
      evidence: [
        {
          evidenceId: "semgrep-sarif",
          locator: { kind: "json_pointer", value: "/runs/0/results/0" },
        },
      ],
      affected: ["%SRCROOT%:src/db.ts:42:7", "lookupUser"],
      remediation: "Use a parameterized query.",
    });
    expect(first.value.findings[0]?.residualRisk).toContain("does not by itself establish");
    expect(first.value.findings[1]).toMatchObject({
      status: "not_established",
      severity: "low",
      confidence: "medium",
      preconditions: ["The SARIF producer marked this result as suppressed"],
    });
  });

  it("keeps a result id stable across ordering changes when SARIF provides a fingerprint", () => {
    const original = sarif();
    const reordered = sarif();
    reordered.runs[0]!.results.reverse();
    const first = normalizeSarif({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "semgrep-sarif",
      sarif: original,
    });
    const second = normalizeSarif({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "semgrep-sarif",
      sarif: reordered,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const firstFinding = first.value.findings.find((finding) => finding.summary.includes("SQL"));
    const secondFinding = second.value.findings.find((finding) => finding.summary.includes("SQL"));
    expect(firstFinding?.id).toBe(secondFinding?.id);
    expect(firstFinding?.evidence[0]?.locator?.value).not.toBe(
      secondFinding?.evidence[0]?.locator?.value,
    );
  });

  it("rejects malformed documents and incomplete results instead of returning a partial set", () => {
    expect(
      normalizeSarif({
        evidenceBundleId: "case-42",
        sourceEvidenceId: "semgrep-sarif",
        sarif: { version: "2.0.0", runs: [] },
      }),
    ).toEqual({ ok: false, issues: [{ path: "version", message: "must be '2.1.0'" }] });

    const missingMessage = sarif();
    (missingMessage.runs[0]!.results[0] as { message?: unknown }).message = undefined;
    const parsed = normalizeSarif({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "semgrep-sarif",
      sarif: missingMessage,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]?.path).toBe("/runs/0/results/0/message");
  });

  it("enforces the finding-set result ceiling", () => {
    const document = sarif();
    (document.runs[0] as { results: unknown[] }).results = Array.from(
      { length: MAX_SARIF_RESULTS + 1 },
      (_, index) => ({
        ruleId: "SEC001",
        ruleIndex: 0,
        message: { text: `Result ${index}` },
      }),
    );
    const parsed = normalizeSarif({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "semgrep-sarif",
      sarif: document,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues).toContainEqual(expect.objectContaining({ path: "runs" }));
  });
});
