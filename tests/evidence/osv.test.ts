import { describe, expect, it } from "bun:test";
import { MAX_OSV_GROUPS, MAX_OSV_VULNERABILITIES, normalizeOsv } from "../../src/evidence";

function document(called = false) {
  return {
    results: [
      {
        source: { path: "/project/go.mod", type: "lockfile" },
        packages: [
          {
            package: {
              name: "github.com/gogo/protobuf",
              version: "1.3.1",
              ecosystem: "Go",
            },
            vulnerabilities: [
              {
                id: "GHSA-c3h9-896r-86jm",
                aliases: ["CVE-2021-3121"],
                summary: "Improper input validation in protobuf",
                details: "A crafted message may trigger unsafe behavior.",
                affected: [
                  {
                    package: { name: "github.com/gogo/protobuf", ecosystem: "Go" },
                    ranges: [
                      {
                        type: "SEMVER",
                        events: [{ introduced: "0" }, { fixed: "1.3.2" }],
                      },
                    ],
                  },
                ],
              },
              {
                id: "GO-2021-0053",
                aliases: ["GHSA-c3h9-896r-86jm"],
                summary: "Improper input validation in protobuf",
              },
            ],
            groups: [
              {
                ids: ["GHSA-c3h9-896r-86jm", "GO-2021-0053"],
                maxSeverity: 9.8,
                experimentalAnalysis: {
                  "GHSA-c3h9-896r-86jm": { called },
                  "GO-2021-0053": { called },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("OSV-Scanner normalization", () => {
  it("groups aliases and maps package, severity, fixed versions, and call analysis", () => {
    const parsed = normalizeOsv({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "osv-json",
      osv: document(false),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.findings).toHaveLength(1);
    expect(parsed.value.findings[0]).toMatchObject({
      status: "not_established",
      severity: "critical",
      confidence: "medium",
      affected: ["Go:github.com/gogo/protobuf@1.3.1 (source: /project/go.mod)"],
      remediation: "Upgrade Go:github.com/gogo/protobuf@1.3.1 to a fixed version: 1.3.2.",
    });
    expect(parsed.value.findings[0]?.evidence).toEqual([
      {
        evidenceId: "osv-json",
        locator: {
          kind: "json_pointer",
          value: "/results/0/packages/0/vulnerabilities/0",
        },
      },
      {
        evidenceId: "osv-json",
        locator: {
          kind: "json_pointer",
          value: "/results/0/packages/0/vulnerabilities/1",
        },
      },
    ]);
    expect(parsed.value.findings[0]?.preconditions).toContain(
      "OSV-Scanner call analysis did not observe the affected code path",
    );
  });

  it("raises confidence without promoting a called dependency match to confirmed", () => {
    const parsed = normalizeOsv({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "osv-json",
      osv: document(true),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.findings[0]?.status).toBe("hypothesis");
      expect(parsed.value.findings[0]?.confidence).toBe("high");
    }
  });

  it("normalizes ungrouped OSV records separately", () => {
    const value = document();
    (value.results[0]!.packages[0]! as { groups?: unknown }).groups = undefined;
    const parsed = normalizeOsv({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "osv-json",
      osv: value,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.findings).toHaveLength(2);
  });

  it("keeps grouped finding identity stable when aliases and records are reordered", () => {
    const first = document();
    const second = structuredClone(first);
    second.results[0]!.packages[0]!.groups[0]!.ids.reverse();
    second.results[0]!.packages[0]!.vulnerabilities.reverse();
    const left = normalizeOsv({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "osv-json",
      osv: first,
    });
    const right = normalizeOsv({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "osv-json",
      osv: second,
    });
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (left.ok && right.ok) expect(left.value.findings[0]?.id).toBe(right.value.findings[0]?.id);
  });

  it("rejects malformed vulnerability records all-or-nothing", () => {
    const value = document();
    value.results[0]!.packages[0]!.vulnerabilities.push({ summary: "missing id" } as never);
    const parsed = normalizeOsv({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "osv-json",
      osv: value,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({
          path: "/results/0/packages/0/vulnerabilities/2/id",
        }),
      );
    }
  });

  it("rejects vulnerability counts above the ceiling", () => {
    const value = document();
    value.results[0]!.packages[0]!.groups = [];
    value.results[0]!.packages[0]!.vulnerabilities = Array.from(
      { length: MAX_OSV_VULNERABILITIES + 1 },
      (_, index) => ({ id: `OSV-2099-${index}` }),
    ) as never;
    const parsed = normalizeOsv({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "osv-json",
      osv: value,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.issues).toContainEqual(expect.objectContaining({ path: "results" }));
  });

  it("rejects vulnerability groups above the ceiling", () => {
    const value = document();
    value.results[0]!.packages[0]!.groups = Array.from({ length: MAX_OSV_GROUPS + 1 }, () => ({
      ids: ["GHSA-c3h9-896r-86jm"],
    })) as never;
    const parsed = normalizeOsv({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "osv-json",
      osv: value,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.issues).toContainEqual(expect.objectContaining({ path: "results" }));
  });
});
