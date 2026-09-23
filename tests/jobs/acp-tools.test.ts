import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { EvidenceRegistry } from "../../src/evidence";
import {
  JOB_ARTIFACT_READ_METHOD,
  JOB_CANCEL_METHOD,
  JOB_START_METHOD,
  JOB_STATUS_METHOD,
  registerClientJobTools,
} from "../../src/jobs";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolContext } from "../../src/tools/types";

const spec = {
  schemaVersion: 1 as const,
  kind: "sast.semgrep",
  evidenceBundleId: "case-1",
  inputEvidenceIds: ["source"],
  effect: "read" as const,
  parameters: { ruleset: "auto" },
  limits: {
    timeoutMs: 60_000,
    maxOutputBytes: 4_096,
    maxArtifactBytes: 8_192,
  },
};

const passiveSpec = {
  ...spec,
  kind: "dast.zap-passive",
  effect: "passive_network" as const,
  target: "https://staging.example.test",
};

const queued = {
  schemaVersion: 1 as const,
  jobId: "job-1",
  kind: "sast.semgrep",
  status: "queued" as const,
  artifacts: [],
};

function context(sessionId = "session-1"): ToolContext {
  return { projectDir: "/project", abortSignal: new AbortController().signal, sessionId };
}

function sarifJson(): string {
  return JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Semgrep",
            rules: [
              {
                id: "sql-injection",
                properties: { "security-severity": "8.2", precision: "high" },
              },
            ],
          },
        },
        results: [
          {
            ruleId: "sql-injection",
            ruleIndex: 0,
            message: { text: "Untrusted input reaches a SQL query" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/db.ts" },
                  region: { startLine: 42 },
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

function cycloneDxJson(): string {
  return JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [
      {
        "bom-ref": "lodash",
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
        ratings: [{ severity: "high" }],
        affects: [{ ref: "lodash" }],
      },
    ],
  });
}

function osvJson(): string {
  return JSON.stringify({
    results: [
      {
        source: { path: "/project/package-lock.json", type: "lockfile" },
        packages: [
          {
            package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
            vulnerabilities: [
              { id: "GHSA-example", summary: "Command injection in lodash templates" },
            ],
            groups: [{ ids: ["GHSA-example"], maxSeverity: 8.1 }],
          },
        ],
      },
    ],
  });
}

function zapJson(): string {
  return JSON.stringify({
    "@programName": "OWASP ZAP",
    "@version": "2.16.1",
    site: [
      {
        "@name": "https://staging.example.test",
        "@host": "staging.example.test",
        "@port": "443",
        "@ssl": "true",
        alerts: [
          {
            pluginid: "10021",
            alertRef: "10021-1",
            name: "X-Content-Type-Options Header Missing",
            riskcode: "1",
            confidence: "3",
            desc: "<p>The response header is missing.</p>",
            instances: [
              {
                uri: "https://staging.example.test/api/users",
                method: "GET",
                param: "",
                attack: "",
                evidence: "",
              },
            ],
            solution: "<p>Set the header to nosniff.</p>",
            cweid: "693",
          },
        ],
      },
    ],
  });
}

function harness(request: (method: string, params: unknown) => Promise<unknown>) {
  const tools = new ToolRegistry();
  const evidenceRegistry = new EvidenceRegistry();
  evidenceRegistry.registerBundles("session-1", [
    {
      schemaVersion: 1,
      bundleId: "case-1",
      items: [
        {
          id: "source",
          kind: "source_tree",
          uri: "file:///project",
          redaction: "none",
          provenance: { source: "test" },
        },
      ],
    },
  ]);
  const jobs = registerClientJobTools({
    tools,
    request,
    capabilities: {
      version: 1,
      kinds: ["sast.semgrep", "dast.zap-passive"],
      maxArtifactReadBytes: 64,
    },
    evidenceRegistry,
  });
  return { tools, jobs, evidenceRegistry };
}

describe("ACP client-managed job tools", () => {
  it("starts only an advertised job backed by session evidence", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { tools, jobs } = harness(async (method, params) => {
      calls.push({ method, params });
      return queued;
    });
    const result = await tools.get("job_start")!.run({ spec }, context());
    expect(tools.get("job_start")!.authorization?.({ spec })).toEqual({
      type: "client_job",
      kind: "sast.semgrep",
      effect: "read",
      limits: spec.limits,
    });
    expect(tools.get("job_start")!.serialize({ spec })).toContain(
      "timeout=60000ms output=4096B artifacts=8192B",
    );
    expect(result.ok).toBe(true);
    expect(result.structuredContent).toEqual({ type: "job_status", value: queued });
    expect(calls).toEqual([{ method: JOB_START_METHOD, params: { sessionId: "session-1", spec } }]);
    expect(jobs.get("session-1", "job-1")?.spec).toEqual(spec);
  });

  it("rejects unregistered evidence before contacting the client", async () => {
    let called = false;
    const { tools } = harness(async () => {
      called = true;
      return queued;
    });
    const result = await tools
      .get("job_start")!
      .run({ spec: { ...spec, inputEvidenceIds: ["unknown"] } }, context());
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("not in bundle");
    expect(called).toBe(false);
  });

  it("rejects a client artifact manifest beyond the declared budget", async () => {
    const { tools } = harness(async () => ({
      ...queued,
      artifacts: [
        {
          artifactId: "oversized",
          name: "oversized.json",
          mimeType: "application/json",
          sizeBytes: spec.limits.maxArtifactBytes + 1,
        },
      ],
    }));
    const result = await tools.get("job_start")!.run({ spec }, context());
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("exceeding job budget");
  });

  it("keeps status and cancellation scoped to jobs owned by the session", async () => {
    const methods: string[] = [];
    const { tools } = harness(async (method) => {
      methods.push(method);
      if (method === JOB_START_METHOD) return queued;
      if (method === JOB_STATUS_METHOD) return { ...queued, status: "running", progress: 0.25 };
      if (method === JOB_CANCEL_METHOD) return { ...queued, status: "cancelled" };
      throw new Error("unexpected method");
    });
    await tools.get("job_start")!.run({ spec }, context());
    const otherSession = await tools
      .get("job_status")!
      .run({ job_id: "job-1" }, context("session-2"));
    expect(otherSession.ok).toBe(false);
    expect(methods).toEqual([JOB_START_METHOD]);

    expect((await tools.get("job_status")!.run({ job_id: "job-1" }, context())).ok).toBe(true);
    expect((await tools.get("job_cancel")!.run({ job_id: "job-1" }, context())).ok).toBe(true);
    expect(methods).toEqual([JOB_START_METHOD, JOB_STATUS_METHOD, JOB_CANCEL_METHOD]);
  });

  it("reads only bounded chunks from owned artifacts", async () => {
    const withArtifact = {
      ...queued,
      status: "succeeded" as const,
      artifacts: [
        {
          artifactId: "report",
          name: "report.json",
          mimeType: "application/json",
          sizeBytes: 11,
        },
      ],
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    const { tools } = harness(async (method, params) => {
      requests.push({ method, params });
      if (method === JOB_START_METHOD) return withArtifact;
      return {
        schemaVersion: 1,
        jobId: "job-1",
        artifactId: "report",
        offset: 0,
        text: '{"ok":true}',
        nextOffset: 11,
        eof: true,
      };
    });
    await tools.get("job_start")!.run({ spec }, context());
    const result = await tools
      .get("job_artifact_read")!
      .run({ job_id: "job-1", artifact_id: "report", max_bytes: 16 }, context());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Untrusted client-managed job artifact");
    expect(requests[1]).toEqual({
      method: JOB_ARTIFACT_READ_METHOD,
      params: {
        sessionId: "session-1",
        jobId: "job-1",
        artifactId: "report",
        offset: 0,
        maxBytes: 16,
      },
    });

    const tooLarge = await tools
      .get("job_artifact_read")!
      .run({ job_id: "job-1", artifact_id: "report", max_bytes: 65 }, context());
    expect(tooLarge.ok).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("normalizes a digest-bound owned SARIF artifact without putting its body in tool args", async () => {
    const body = sarifJson();
    const sha256 = createHash("sha256").update(body).digest("hex");
    const withArtifact = {
      ...queued,
      status: "succeeded" as const,
      artifacts: [
        {
          artifactId: "sarif-report",
          name: "semgrep.sarif",
          mimeType: "application/sarif+json",
          sizeBytes: Buffer.byteLength(body),
          sha256,
        },
      ],
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    const { tools, evidenceRegistry } = harness(async (method, params) => {
      requests.push({ method, params });
      if (method === JOB_START_METHOD) return withArtifact;
      const request = params as { offset: number; maxBytes: number };
      const text = body.slice(request.offset, request.offset + request.maxBytes);
      const nextOffset = request.offset + Buffer.byteLength(text);
      return {
        schemaVersion: 1,
        jobId: "job-1",
        artifactId: "sarif-report",
        offset: request.offset,
        text,
        ...(nextOffset < Buffer.byteLength(body) ? { nextOffset } : {}),
        eof: nextOffset === Buffer.byteLength(body),
      };
    });
    evidenceRegistry.registerBundles("session-1", [
      {
        schemaVersion: 1,
        bundleId: "scan-output",
        items: [
          {
            id: "semgrep-sarif",
            kind: "sast_result",
            uri: "ccsec://cases/1/semgrep.sarif",
            mimeType: "application/sarif+json",
            digest: { algorithm: "sha256", value: sha256 },
            sizeBytes: Buffer.byteLength(body),
            redaction: "none",
            provenance: { source: "Semgrep", tool: "semgrep" },
          },
        ],
      },
    ]);
    await tools.get("job_start")!.run({ spec }, context());

    const tool = tools.get("job_artifact_normalize")!;
    expect(JSON.stringify(tool.parameters)).not.toContain("sarif_json");
    const result = await tool.run(
      {
        job_id: "job-1",
        artifact_id: "sarif-report",
        format: "sarif",
        evidence_bundle_id: "scan-output",
        source_evidence_id: "semgrep-sarif",
      },
      context(),
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("artifact SHA-256 matched");
    expect(result.structuredContent).toMatchObject({
      type: "finding_set",
      value: {
        evidenceBundleId: "scan-output",
        findings: [
          {
            status: "hypothesis",
            severity: "high",
            evidence: [
              {
                evidenceId: "semgrep-sarif",
                locator: { kind: "json_pointer", value: "/runs/0/results/0" },
              },
            ],
          },
        ],
      },
    });
    expect(requests.length).toBeGreaterThan(2);
    expect(requests.slice(1).every((request) => request.method === JOB_ARTIFACT_READ_METHOD)).toBe(
      true,
    );
  });

  it("normalizes digest-bound CycloneDX and OSV-Scanner artifacts through the same surface", async () => {
    const scenarios = [
      {
        format: "cyclonedx",
        body: cycloneDxJson(),
        artifactId: "cyclonedx-report",
        evidenceId: "sca-cyclonedx",
        expectedFindingPrefix: "cyclonedx-",
      },
      {
        format: "osv",
        body: osvJson(),
        artifactId: "osv-report",
        evidenceId: "sca-osv",
        expectedFindingPrefix: "osv-",
      },
    ] as const;

    for (const scenario of scenarios) {
      const sha256 = createHash("sha256").update(scenario.body).digest("hex");
      const { tools, evidenceRegistry } = harness(async (method, params) => {
        if (method === JOB_START_METHOD) {
          return {
            ...queued,
            status: "succeeded",
            artifacts: [
              {
                artifactId: scenario.artifactId,
                name: `${scenario.artifactId}.json`,
                mimeType: "application/json",
                sizeBytes: Buffer.byteLength(scenario.body),
                sha256,
              },
            ],
          };
        }
        const request = params as { offset: number; maxBytes: number };
        const text = scenario.body.slice(request.offset, request.offset + request.maxBytes);
        const nextOffset = request.offset + Buffer.byteLength(text);
        return {
          schemaVersion: 1,
          jobId: "job-1",
          artifactId: scenario.artifactId,
          offset: request.offset,
          text,
          ...(nextOffset < Buffer.byteLength(scenario.body) ? { nextOffset } : {}),
          eof: nextOffset === Buffer.byteLength(scenario.body),
        };
      });
      evidenceRegistry.registerBundles("session-1", [
        {
          schemaVersion: 1,
          bundleId: "scan-output",
          items: [
            {
              id: scenario.evidenceId,
              kind: "sca_result",
              uri: `ccsec://cases/1/${scenario.artifactId}.json`,
              digest: { algorithm: "sha256", value: sha256 },
              sizeBytes: Buffer.byteLength(scenario.body),
              redaction: "none",
              provenance: { source: "test scanner" },
            },
          ],
        },
      ]);
      await tools.get("job_start")!.run({ spec }, context());
      const normalizeTool = tools.get("job_artifact_normalize")!;
      expect(JSON.stringify(normalizeTool.parameters)).toContain(scenario.format);
      const result = await normalizeTool.run(
        {
          job_id: "job-1",
          artifact_id: scenario.artifactId,
          format: scenario.format,
          evidence_bundle_id: "scan-output",
          source_evidence_id: scenario.evidenceId,
        },
        context(),
      );
      expect(result.ok).toBe(true);
      expect(result.output).toContain("artifact SHA-256 matched");
      expect(result.structuredContent).toMatchObject({
        type: "finding_set",
        value: {
          evidenceBundleId: "scan-output",
          findings: [{ id: expect.stringMatching(scenario.expectedFindingPrefix) }],
        },
      });
    }
  });

  it("normalizes a passive ZAP report only for a passive-network job", async () => {
    const body = zapJson();
    const sha256 = createHash("sha256").update(body).digest("hex");
    const withArtifact = {
      ...queued,
      kind: passiveSpec.kind,
      status: "succeeded" as const,
      artifacts: [
        {
          artifactId: "zap-report",
          name: "zap-report.json",
          mimeType: "application/json",
          sizeBytes: Buffer.byteLength(body),
          sha256,
        },
      ],
    };
    const { tools, evidenceRegistry } = harness(async (method, params) => {
      if (method === JOB_START_METHOD) return withArtifact;
      const request = params as { offset: number; maxBytes: number };
      const text = body.slice(request.offset, request.offset + request.maxBytes);
      const nextOffset = request.offset + Buffer.byteLength(text);
      return {
        schemaVersion: 1,
        jobId: "job-1",
        artifactId: "zap-report",
        offset: request.offset,
        text,
        ...(nextOffset < Buffer.byteLength(body) ? { nextOffset } : {}),
        eof: nextOffset === Buffer.byteLength(body),
      };
    });
    evidenceRegistry.registerBundles("session-1", [
      {
        schemaVersion: 1,
        bundleId: "scan-output",
        items: [
          {
            id: "zap-json",
            kind: "dast_result",
            uri: "ccsec://cases/1/zap-report.json",
            digest: { algorithm: "sha256", value: sha256 },
            sizeBytes: Buffer.byteLength(body),
            redaction: "none",
            provenance: { source: "OWASP ZAP", tool: "zap" },
          },
        ],
      },
    ]);
    await tools.get("job_start")!.run({ spec: passiveSpec }, context());
    const result = await tools.get("job_artifact_normalize")!.run(
      {
        job_id: "job-1",
        artifact_id: "zap-report",
        format: "zap-passive",
        evidence_bundle_id: "scan-output",
        source_evidence_id: "zap-json",
      },
      context(),
    );
    expect(result.ok).toBe(true);
    expect(result.structuredContent).toMatchObject({
      type: "finding_set",
      value: {
        evidenceBundleId: "scan-output",
        findings: [
          {
            id: expect.stringMatching(/^zap-/),
            status: "hypothesis",
            preconditions: [
              "Client job declared passive-network execution for target https://staging.example.test",
              "ZAP confidence: high",
            ],
          },
        ],
      },
    });
  });

  it("rejects passive ZAP normalization when the owning job was not authorized as passive", async () => {
    const body = zapJson();
    const sha256 = createHash("sha256").update(body).digest("hex");
    const requests: string[] = [];
    const { tools } = harness(async (method) => {
      requests.push(method);
      return {
        ...queued,
        status: "succeeded",
        artifacts: [
          {
            artifactId: "zap-report",
            name: "zap-report.json",
            mimeType: "application/json",
            sizeBytes: Buffer.byteLength(body),
            sha256,
          },
        ],
      };
    });
    await tools.get("job_start")!.run({ spec }, context());
    const result = await tools.get("job_artifact_normalize")!.run(
      {
        job_id: "job-1",
        artifact_id: "zap-report",
        format: "zap-passive",
        evidence_bundle_id: "scan-output",
        source_evidence_id: "zap-json",
      },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain(
      "requires a job authorized with effect 'passive_network'",
    );
    expect(requests).toEqual([JOB_START_METHOD]);
  });

  it("rejects passive ZAP normalization for a differently declared job kind", async () => {
    const body = zapJson();
    const sha256 = createHash("sha256").update(body).digest("hex");
    const requests: string[] = [];
    const { tools } = harness(async (method) => {
      requests.push(method);
      return {
        ...queued,
        status: "succeeded",
        artifacts: [
          {
            artifactId: "zap-report",
            name: "zap-report.json",
            mimeType: "application/json",
            sizeBytes: Buffer.byteLength(body),
            sha256,
          },
        ],
      };
    });
    await tools.get("job_start")!.run(
      {
        spec: {
          ...spec,
          effect: "passive_network",
          target: "https://staging.example.test",
        },
      },
      context(),
    );
    const result = await tools.get("job_artifact_normalize")!.run(
      {
        job_id: "job-1",
        artifact_id: "zap-report",
        format: "zap-passive",
        evidence_bundle_id: "scan-output",
        source_evidence_id: "zap-json",
      },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("requires a job with kind 'dast.zap-passive'");
    expect(requests).toEqual([JOB_START_METHOD]);
  });

  it("rejects SARIF normalization before reading when artifact and evidence digests differ", async () => {
    const body = sarifJson();
    const sha256 = createHash("sha256").update(body).digest("hex");
    const requests: string[] = [];
    const { tools, evidenceRegistry } = harness(async (method) => {
      requests.push(method);
      return {
        ...queued,
        status: "succeeded",
        artifacts: [
          {
            artifactId: "sarif-report",
            name: "semgrep.sarif",
            mimeType: "application/sarif+json",
            sizeBytes: Buffer.byteLength(body),
            sha256,
          },
        ],
      };
    });
    evidenceRegistry.registerBundles("session-1", [
      {
        schemaVersion: 1,
        bundleId: "scan-output",
        items: [
          {
            id: "semgrep-sarif",
            kind: "sast_result",
            uri: "ccsec://cases/1/other.sarif",
            digest: { algorithm: "sha256", value: "0".repeat(64) },
            redaction: "none",
            provenance: { source: "test" },
          },
        ],
      },
    ]);
    await tools.get("job_start")!.run({ spec }, context());
    const result = await tools.get("job_artifact_normalize")!.run(
      {
        job_id: "job-1",
        artifact_id: "sarif-report",
        format: "sarif",
        evidence_bundle_id: "scan-output",
        source_evidence_id: "semgrep-sarif",
      },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("SHA-256 values do not match");
    expect(requests).toEqual([JOB_START_METHOD]);
  });

  it("rejects retrieved SARIF bytes that do not match the bound digest", async () => {
    const body = sarifJson();
    const changedBody = body.replace("SQL query", "SQL querx");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const { tools, evidenceRegistry } = harness(async (method, params) => {
      if (method === JOB_START_METHOD) {
        return {
          ...queued,
          status: "succeeded",
          artifacts: [
            {
              artifactId: "sarif-report",
              name: "semgrep.sarif",
              mimeType: "application/sarif+json",
              sizeBytes: Buffer.byteLength(body),
              sha256,
            },
          ],
        };
      }
      const request = params as { offset: number; maxBytes: number };
      const text = changedBody.slice(request.offset, request.offset + request.maxBytes);
      const nextOffset = request.offset + Buffer.byteLength(text);
      return {
        schemaVersion: 1,
        jobId: "job-1",
        artifactId: "sarif-report",
        offset: request.offset,
        text,
        ...(nextOffset < Buffer.byteLength(changedBody) ? { nextOffset } : {}),
        eof: nextOffset === Buffer.byteLength(changedBody),
      };
    });
    evidenceRegistry.registerBundles("session-1", [
      {
        schemaVersion: 1,
        bundleId: "scan-output",
        items: [
          {
            id: "semgrep-sarif",
            kind: "sast_result",
            uri: "ccsec://cases/1/semgrep.sarif",
            digest: { algorithm: "sha256", value: sha256 },
            redaction: "none",
            provenance: { source: "test" },
          },
        ],
      },
    ]);
    await tools.get("job_start")!.run({ spec }, context());
    const result = await tools.get("job_artifact_normalize")!.run(
      {
        job_id: "job-1",
        artifact_id: "sarif-report",
        format: "sarif",
        evidence_bundle_id: "scan-output",
        source_evidence_id: "semgrep-sarif",
      },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("content does not match its advertised SHA-256");
  });
});
