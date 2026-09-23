import { describe, expect, it } from "bun:test";
import { parseJobArtifactChunk, parseJobSpec, parseJobStatus } from "../../src/jobs";

const limits = {
  timeoutMs: 60_000,
  maxOutputBytes: 1_024,
  maxArtifactBytes: 1_024,
};

describe("client job contracts", () => {
  it("normalizes optional arrays and parameter maps", () => {
    const parsed = parseJobSpec({
      schemaVersion: 1,
      kind: "sast.semgrep",
      effect: "read",
      limits,
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        kind: "sast.semgrep",
        effect: "read",
        inputEvidenceIds: [],
        parameters: {},
        limits,
      },
    });
  });

  it("requires a bundle and unique ids for evidence inputs", () => {
    const missingBundle = parseJobSpec({
      schemaVersion: 1,
      kind: "sast.semgrep",
      inputEvidenceIds: ["source"],
      effect: "read",
      limits,
    });
    expect(missingBundle.ok).toBe(false);

    const duplicate = parseJobSpec({
      schemaVersion: 1,
      kind: "sast.semgrep",
      evidenceBundleId: "case-1",
      inputEvidenceIds: ["source", "source"],
      effect: "read",
      limits,
    });
    expect(duplicate.ok).toBe(false);
  });

  it("requires an explicit target for network and write effects", () => {
    for (const effect of ["passive_network", "active_network", "write"] as const) {
      expect(
        parseJobSpec({
          schemaVersion: 1,
          kind: "scanner",
          effect,
          limits,
        }).ok,
      ).toBe(false);
    }
    expect(
      parseJobSpec({
        schemaVersion: 1,
        kind: "scanner",
        effect: "passive_network",
        target: "https://staging.example.com",
        limits,
      }).ok,
    ).toBe(true);
  });

  it("requires failed statuses to carry an error", () => {
    expect(
      parseJobStatus({
        schemaVersion: 1,
        jobId: "job-1",
        kind: "sast.semgrep",
        status: "failed",
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-final chunk that cannot advance", () => {
    expect(
      parseJobArtifactChunk({
        schemaVersion: 1,
        jobId: "job-1",
        artifactId: "report",
        offset: 0,
        text: "partial",
        eof: false,
      }).ok,
    ).toBe(false);
  });
});
