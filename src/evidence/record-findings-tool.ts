import type { Tool, ToolContext, ToolResult } from "../tools/types";
import type { FindingSet } from "./contracts";
import type { EvidenceRegistry } from "./registry";

const FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "summary", "status", "severity", "confidence"],
  properties: {
    id: { type: "string" },
    summary: { type: "string" },
    status: {
      type: "string",
      enum: ["confirmed", "hypothesis", "not_established", "refuted"],
    },
    severity: {
      type: "string",
      enum: ["informational", "low", "medium", "high", "critical"],
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId"],
        properties: {
          evidenceId: { type: "string" },
          locator: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value"],
            properties: {
              kind: {
                type: "string",
                enum: ["line", "symbol", "timestamp", "json_pointer", "byte_range", "other"],
              },
              value: { type: "string" },
            },
          },
        },
      },
    },
    affected: { type: "array", items: { type: "string" } },
    preconditions: { type: "array", items: { type: "string" } },
    impact: { type: "string" },
    remediation: { type: "string" },
    verification: { type: "string" },
    residualRisk: { type: "string" },
  },
} as const;

export class RecordFindingsTool implements Tool {
  name = "record_findings";
  description =
    "Record a structured, evidence-backed finding set for an evidence bundle supplied by the ACP client. Use only when the user requests structured findings or a security investigation based on a client evidence bundle.";
  parameters = {
    type: "object",
    additionalProperties: false,
    required: ["finding_set"],
    properties: {
      finding_set: {
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "findingSetId", "evidenceBundleId", "findings"],
        properties: {
          schemaVersion: { type: "integer", enum: [1] },
          findingSetId: { type: "string" },
          evidenceBundleId: { type: "string" },
          findings: { type: "array", items: FINDING_SCHEMA },
        },
      },
    },
  };

  constructor(private readonly registry: EvidenceRegistry) {}

  serialize(args: unknown): string {
    const set = findingSetArg(args) as { findingSetId?: unknown; findings?: unknown } | undefined;
    const count = Array.isArray(set?.findings) ? set.findings.length : 0;
    const id = typeof set?.findingSetId === "string" ? set.findingSetId : "unknown";
    return `record_findings ${id} (${count} finding${count === 1 ? "" : "s"})`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.sessionId) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: "record_findings requires an active ACP session",
      };
    }
    const recorded = this.registry.recordFindingSet(ctx.sessionId, findingSetArg(args));
    if (!recorded.ok) {
      const detail = recorded.issues
        .slice(0, 8)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ");
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: `finding set rejected: ${detail}`,
      };
    }
    const counts = summarize(recorded.value);
    return {
      ok: true,
      output:
        `Recorded ${recorded.value.findings.length} structured finding${recorded.value.findings.length === 1 ? "" : "s"} ` +
        `for evidence bundle ${recorded.value.evidenceBundleId}${counts ? ` (${counts})` : ""}.`,
      structuredContent: { type: "finding_set", value: recorded.value },
    };
  }
}

function findingSetArg(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = args as Record<string, unknown>;
  return value.finding_set ?? value.findingSet;
}

function summarize(set: FindingSet): string {
  const counts = new Map<string, number>();
  for (const finding of set.findings) {
    counts.set(finding.status, (counts.get(finding.status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => `${count} ${status.replace("_", " ")}`)
    .join(", ");
}
