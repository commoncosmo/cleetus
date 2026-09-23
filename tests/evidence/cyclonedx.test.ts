import { describe, expect, it } from "bun:test";
import { MAX_CYCLONEDX_VULNERABILITIES, normalizeCycloneDx } from "../../src/evidence";

function document() {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [
      {
        "bom-ref": "component-lodash",
        type: "library",
        name: "lodash",
        version: "4.17.20",
        purl: "pkg:npm/lodash@4.17.20",
      },
    ],
    vulnerabilities: [
      {
        id: "CVE-2021-23337",
        description: "Command injection in lodash templates",
        detail: "An attacker may inject commands through an unsafe template option.",
        recommendation: "Upgrade lodash to 4.17.21 or later.",
        ratings: [{ severity: "high" }, { score: 9.1, method: "CVSSv31" }],
        analysis: {
          state: "exploitable",
          justification: "requires_environment",
          response: ["update"],
        },
        affects: [{ ref: "component-lodash" }],
      },
    ],
  };
}

describe("CycloneDX normalization", () => {
  it("maps vulnerability ratings, component refs, analysis, and remediation", () => {
    const parsed = normalizeCycloneDx({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "sca-cdx",
      cyclonedx: document(),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.findings).toHaveLength(1);
    expect(parsed.value.findings[0]).toMatchObject({
      status: "hypothesis",
      severity: "critical",
      confidence: "high",
      affected: ["pkg:npm/lodash@4.17.20"],
      evidence: [
        {
          evidenceId: "sca-cdx",
          locator: { kind: "json_pointer", value: "/vulnerabilities/0" },
        },
      ],
      remediation: "Upgrade lodash to 4.17.21 or later.",
    });
    expect(parsed.value.findings[0]?.preconditions).toContain(
      "CycloneDX analysis state: exploitable",
    );
    expect(parsed.value.findings[0]?.residualRisk).toContain("reachability");
  });

  it("keeps VEX not-affected assertions below confirmed status", () => {
    const value = document();
    value.vulnerabilities[0]!.analysis.state = "not_affected";
    const parsed = normalizeCycloneDx({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "vex-cdx",
      cyclonedx: value,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.findings[0]?.status).toBe("not_established");
  });

  it("uses stable finding identity independent of component and rating order", () => {
    const first = document();
    first.components.push({
      "bom-ref": "unrelated",
      type: "library",
      name: "left-pad",
      version: "1.3.0",
      purl: "pkg:npm/left-pad@1.3.0",
    });
    const second = structuredClone(first);
    second.components.reverse();
    second.vulnerabilities[0]!.ratings.reverse();
    const left = normalizeCycloneDx({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "sca-cdx",
      cyclonedx: first,
    });
    const right = normalizeCycloneDx({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "sca-cdx",
      cyclonedx: second,
    });
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (left.ok && right.ok) expect(left.value.findings[0]?.id).toBe(right.value.findings[0]?.id);
  });

  it("rejects malformed vulnerabilities all-or-nothing", () => {
    const value = document();
    value.vulnerabilities.push({ affects: [{ ref: "component-lodash" }] } as never);
    const parsed = normalizeCycloneDx({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "sca-cdx",
      cyclonedx: value,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ path: "/vulnerabilities/1/id" }),
      );
    }
  });

  it("rejects unsupported versions and vulnerability counts above the ceiling", () => {
    const unsupported = { ...document(), specVersion: "1.3" };
    expect(
      normalizeCycloneDx({
        evidenceBundleId: "case-42",
        sourceEvidenceId: "sca-cdx",
        cyclonedx: unsupported,
      }).ok,
    ).toBe(false);

    const tooMany = document();
    tooMany.vulnerabilities = Array.from(
      { length: MAX_CYCLONEDX_VULNERABILITIES + 1 },
      (_, index) => ({ id: `CVE-2099-${index}`, affects: [] }),
    ) as never;
    const parsed = normalizeCycloneDx({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "sca-cdx",
      cyclonedx: tooMany,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toContainEqual(expect.objectContaining({ path: "vulnerabilities" }));
    }
  });
});
