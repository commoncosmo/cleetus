import { describe, expect, it } from "bun:test";
import {
  EVIDENCE_BUNDLE_MIME_TYPE,
  parseEvidenceBundle,
  parseEvidenceBundleJson,
  parseFindingSet,
  validateFindingSetEvidence,
} from "../../src/evidence";

const SHA256 = "a".repeat(64);

function bundle() {
  return {
    schemaVersion: 1,
    bundleId: "case-2026-09-21",
    title: "Suspicious request evidence",
    items: [
      {
        id: "nginx-log-1",
        kind: "web_server_log",
        uri: "ccsec://cases/42/nginx.jsonl",
        mimeType: "application/x-ndjson",
        digest: { algorithm: "sha256", value: SHA256 },
        sizeBytes: 2048,
        redaction: "applied",
        provenance: {
          source: "nginx export",
          collectedAt: "2026-09-21T17:00:00-05:00",
          tool: "ccsec-import",
          toolVersion: "0.1.0",
        },
      },
    ],
  };
}

describe("evidence bundle contracts", () => {
  it("parses bounded provenance metadata and applies explicit defaults", () => {
    const input = bundle();
    (input.items[0] as { redaction?: string }).redaction = undefined;
    const parsed = parseEvidenceBundle(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.items[0]?.redaction).toBe("unknown");
      expect(parsed.value.items[0]?.digest?.value).toBe(SHA256);
    }
    expect(EVIDENCE_BUNDLE_MIME_TYPE).toContain("cleetus-evidence-bundle");
  });

  it("rejects invalid JSON without throwing", () => {
    expect(parseEvidenceBundleJson("{nope")).toEqual({
      ok: false,
      issues: [{ path: "$", message: expect.stringContaining("invalid JSON") }],
    });
  });

  it("rejects duplicate evidence ids and malformed digests", () => {
    const input = bundle();
    input.items.push({ ...input.items[0]!, digest: { algorithm: "sha256", value: "short" } });
    const parsed = parseEvidenceBundle(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "items.1.id",
            message: expect.stringContaining("duplicate"),
          }),
          expect.objectContaining({
            path: "items.1.digest.value",
            message: expect.stringContaining("SHA-256"),
          }),
        ]),
      );
    }
  });
});

describe("finding contracts", () => {
  it("accepts a cited confirmed finding and resolves its evidence", () => {
    const parsedBundle = parseEvidenceBundle(bundle());
    const parsedSet = parseFindingSet({
      schemaVersion: 1,
      findingSetId: "findings-42",
      evidenceBundleId: "case-2026-09-21",
      findings: [
        {
          id: "finding-1",
          summary: "A suspicious request reached the legacy route",
          status: "confirmed",
          severity: "medium",
          confidence: "high",
          evidence: [
            {
              evidenceId: "nginx-log-1",
              locator: { kind: "line", value: "184" },
            },
          ],
          affected: ["GET /legacy"],
          preconditions: ["The legacy route is enabled"],
          verification: "Replay the request against an approved local target",
        },
      ],
    });
    expect(parsedBundle.ok).toBe(true);
    expect(parsedSet.ok).toBe(true);
    if (parsedBundle.ok && parsedSet.ok) {
      expect(validateFindingSetEvidence(parsedSet.value, parsedBundle.value)).toEqual([]);
    }
  });

  it("requires evidence for confirmed or refuted findings", () => {
    const parsed = parseFindingSet({
      schemaVersion: 1,
      findingSetId: "findings-42",
      evidenceBundleId: "case-2026-09-21",
      findings: [
        {
          id: "finding-1",
          summary: "Unsupported conclusion",
          status: "confirmed",
          severity: "high",
          confidence: "high",
        },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]?.message).toContain("require at least one evidence");
  });

  it("reports cross-document bundle and evidence identity errors", () => {
    const parsedBundle = parseEvidenceBundle(bundle());
    const parsedSet = parseFindingSet({
      schemaVersion: 1,
      findingSetId: "findings-42",
      evidenceBundleId: "some-other-bundle",
      findings: [
        {
          id: "finding-1",
          summary: "Possible issue",
          status: "hypothesis",
          severity: "low",
          confidence: "low",
          evidence: [{ evidenceId: "missing-evidence" }],
        },
      ],
    });
    expect(parsedBundle.ok && parsedSet.ok).toBe(true);
    if (parsedBundle.ok && parsedSet.ok) {
      expect(validateFindingSetEvidence(parsedSet.value, parsedBundle.value)).toEqual([
        expect.objectContaining({ path: "evidenceBundleId" }),
        expect.objectContaining({
          path: "findings.0.evidence.0.evidenceId",
          message: expect.stringContaining("missing-evidence"),
        }),
      ]);
    }
  });
});
