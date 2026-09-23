import { describe, expect, it } from "bun:test";
import {
  MAX_SECURITY_SESSION_STATE_BYTES,
  rehydrateSecuritySessionState,
  securityStateFromLoadParams,
} from "../../src/acp/security-state";
import { EvidenceRegistry } from "../../src/evidence";
import { JobRegistry } from "../../src/jobs";

const digest = "a".repeat(64);

function bundle(title = "Investigation") {
  return {
    schemaVersion: 1 as const,
    bundleId: "case-1",
    title,
    items: [
      {
        id: "zap-report",
        kind: "dast_report",
        uri: "ccsec://cases/1/zap.json",
        mimeType: "application/json",
        digest: { algorithm: "sha256" as const, value: digest },
        sizeBytes: 42,
        redaction: "none" as const,
        provenance: { source: "ccsec", tool: "OWASP ZAP" },
      },
    ],
  };
}

const spec = {
  schemaVersion: 1 as const,
  kind: "dast.zap-passive",
  evidenceBundleId: "case-1",
  inputEvidenceIds: ["zap-report"],
  target: "https://staging.example.test",
  effect: "passive_network" as const,
  parameters: { spiderMinutes: 1 },
  limits: {
    timeoutMs: 60_000,
    maxOutputBytes: 4_096,
    maxArtifactBytes: 8_192,
  },
};

const status = {
  schemaVersion: 1 as const,
  jobId: "job-1",
  kind: "dast.zap-passive",
  status: "succeeded" as const,
  artifacts: [
    {
      artifactId: "zap-json",
      name: "zap.json",
      mimeType: "application/json",
      sizeBytes: 42,
      sha256: digest,
      uri: "ccsec://jobs/job-1/zap.json",
    },
  ],
};

const findingSet = {
  schemaVersion: 1 as const,
  findingSetId: "zap-findings",
  evidenceBundleId: "case-1",
  findings: [
    {
      id: "finding-1",
      summary: "A response header is missing",
      status: "hypothesis" as const,
      severity: "low" as const,
      confidence: "high" as const,
      evidence: [
        {
          evidenceId: "zap-report",
          locator: { kind: "json_pointer" as const, value: "/site/0/alerts/0" },
        },
      ],
      affected: ["GET /api/users"],
      preconditions: ["The endpoint is reachable"],
    },
  ],
};

function state(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    evidenceBundles: [bundle()],
    findingSets: [findingSet],
    jobs: [{ spec, status }],
    ...overrides,
  };
}

function refs() {
  return {
    evidenceRegistry: new EvidenceRegistry(),
    jobRegistry: new JobRegistry(),
    jobCapabilities: {
      version: 1 as const,
      kinds: ["dast.zap-passive"],
      maxArtifactReadBytes: 65_536,
    },
  };
}

describe("ACP security-state reattachment", () => {
  it("extracts only the namespaced session/load extension", () => {
    expect(securityStateFromLoadParams({ _meta: { unrelated: state() } })).toEqual({
      present: false,
    });
    expect(
      securityStateFromLoadParams({
        _meta: { "commoncosmo.com": { cleetus: { securityState: state() } } },
      }),
    ).toEqual({ present: true, value: state() });
  });

  it("restores evidence, findings, and digest-bound job ownership", () => {
    const registries = refs();
    const result = rehydrateSecuritySessionState("session-1", state(), registries);
    expect(result).toEqual({
      ok: true,
      value: { schemaVersion: 1, evidenceBundles: 1, findingSets: 1, jobs: 1 },
    });
    expect(registries.evidenceRegistry.bundle("session-1", "case-1")).toEqual(bundle());
    expect(registries.evidenceRegistry.findingSet("session-1", "zap-findings")).toEqual(findingSet);
    expect(registries.jobRegistry.get("session-1", "job-1")?.spec).toEqual(spec);
    expect(registries.jobRegistry.artifact("session-1", "job-1", "zap-json")?.sha256).toBe(digest);
  });

  it("is idempotent but rejects immutable identity reuse without replacing prior state", () => {
    const registries = refs();
    expect(rehydrateSecuritySessionState("session-1", state(), registries).ok).toBe(true);
    expect(rehydrateSecuritySessionState("session-1", state(), registries).ok).toBe(true);

    const changed = state({
      evidenceBundles: [bundle("Changed")],
      jobs: [{ spec: { ...spec, title: "Changed" }, status }],
    });
    const result = rehydrateSecuritySessionState("session-1", changed, registries);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reattachment failure");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("different evidence bundle") }),
        expect.objectContaining({
          message: expect.stringContaining("different job specification"),
        }),
      ]),
    );
    expect(registries.evidenceRegistry.bundle("session-1", "case-1")?.title).toBe("Investigation");
    expect(registries.jobRegistry.get("session-1", "job-1")?.spec.title).toBeUndefined();

    const changedArtifact = rehydrateSecuritySessionState(
      "session-1",
      state({
        jobs: [
          {
            spec,
            status: {
              ...status,
              artifacts: [{ ...status.artifacts[0], sha256: "c".repeat(64) }],
            },
          },
        ],
      }),
      registries,
    );
    expect(changedArtifact.ok).toBe(false);
    if (changedArtifact.ok) throw new Error("expected artifact identity failure");
    expect(changedArtifact.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("different artifact manifest"),
        }),
      ]),
    );
    expect(registries.jobRegistry.artifact("session-1", "job-1", "zap-json")?.sha256).toBe(digest);
  });

  it("fails closed for unsupported kinds, missing evidence, or artifacts without digests", () => {
    const unsupported = rehydrateSecuritySessionState("session-1", state(), {
      ...refs(),
      jobCapabilities: {
        version: 1,
        kinds: ["sast.semgrep"],
        maxArtifactReadBytes: 65_536,
      },
    });
    expect(unsupported.ok).toBe(false);
    if (unsupported.ok) throw new Error("expected unsupported-kind failure");
    expect(unsupported.issues[0]?.message).toContain("was not advertised");

    const missingEvidence = rehydrateSecuritySessionState(
      "session-1",
      state({ evidenceBundles: [], findingSets: [] }),
      refs(),
    );
    expect(missingEvidence.ok).toBe(false);
    if (missingEvidence.ok) throw new Error("expected evidence failure");
    expect(missingEvidence.issues[0]?.message).toContain("is not registered");

    const noDigest = rehydrateSecuritySessionState(
      "session-1",
      state({
        jobs: [
          {
            spec,
            status: {
              ...status,
              artifacts: [{ ...status.artifacts[0], sha256: undefined }],
            },
          },
        ],
      }),
      refs(),
    );
    expect(noDigest.ok).toBe(false);
    if (noDigest.ok) throw new Error("expected digest failure");
    expect(noDigest.issues[0]?.message).toContain("required when reattaching");
  });

  it("does not restore job ownership unless the client advertised managed jobs", () => {
    const registries = refs();
    const result = rehydrateSecuritySessionState("session-1", state(), {
      evidenceRegistry: registries.evidenceRegistry,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected capability failure");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("did not advertise") }),
      ]),
    );
    expect(registries.evidenceRegistry.bundle("session-1", "case-1")).toBeUndefined();
  });

  it("rejects oversized or non-JSON resume manifests before registry validation", () => {
    const oversized = rehydrateSecuritySessionState(
      "session-1",
      { schemaVersion: 1, padding: "x".repeat(MAX_SECURITY_SESSION_STATE_BYTES) },
      refs(),
    );
    expect(oversized.ok).toBe(false);
    if (oversized.ok) throw new Error("expected size failure");
    expect(oversized.issues[0]?.message).toContain("encoded bytes");

    const circular: Record<string, unknown> = { schemaVersion: 1 };
    circular.self = circular;
    const nonJson = rehydrateSecuritySessionState("session-1", circular, refs());
    expect(nonJson).toEqual({
      ok: false,
      issues: [{ path: "$", message: "must be JSON-serializable" }],
    });
  });
});
