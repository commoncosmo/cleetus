import { createHash } from "node:crypto";
import type { ContractIssue, ContractParseResult, Finding, FindingSet } from "./contracts";
import { parseFindingSet } from "./contracts";

export const CYCLONEDX_JSON_MIME_TYPE = "application/vnd.cyclonedx+json";
export const MAX_CYCLONEDX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_CYCLONEDX_COMPONENTS = 4_096;
export const MAX_CYCLONEDX_VULNERABILITIES = 256;
export const MAX_CYCLONEDX_AFFECTS = 64;

export interface NormalizeCycloneDxInput {
  evidenceBundleId: string;
  sourceEvidenceId: string;
  cyclonedx: unknown;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function array(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedText(value: unknown, fallback?: string): string | undefined {
  const text = string(value)?.replace(/\s+/gu, " ") ?? fallback;
  if (!text) return undefined;
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function severityRank(value: Finding["severity"]): number {
  return ["informational", "low", "medium", "high", "critical"].indexOf(value);
}

function scoreSeverity(value: unknown): Finding["severity"] | undefined {
  const score =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(score) || score < 0 || score > 10) return undefined;
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "informational";
}

function namedSeverity(value: unknown): Finding["severity"] | undefined {
  switch (string(value)?.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
    case "moderate":
      return "medium";
    case "low":
      return "low";
    case "info":
    case "informational":
    case "none":
    case "unknown":
      return "informational";
    default:
      return undefined;
  }
}

function vulnerabilitySeverity(
  vulnerability: JsonRecord,
): ContractParseResult<Finding["severity"]> {
  if (vulnerability.ratings === undefined) return { ok: true, value: "informational" };
  const ratings = array(vulnerability.ratings);
  if (!ratings) {
    return { ok: false, issues: [{ path: "ratings", message: "must be an array" }] };
  }
  let selected: Finding["severity"] = "informational";
  for (const [index, rawRating] of ratings.entries()) {
    const rating = record(rawRating);
    if (!rating) {
      return {
        ok: false,
        issues: [{ path: `ratings.${index}`, message: "must be an object" }],
      };
    }
    const candidate = namedSeverity(rating.severity) ?? scoreSeverity(rating.score);
    if (candidate && severityRank(candidate) > severityRank(selected)) selected = candidate;
  }
  return { ok: true, value: selected };
}

function componentIdentity(component: JsonRecord, fallback: string): string {
  const purl = string(component.purl);
  if (purl) return purl;
  const name = string(component.name);
  if (!name) return fallback;
  const group = string(component.group);
  const version = string(component.version);
  return `${group ? `${group}/` : ""}${name}${version ? `@${version}` : ""}`;
}

function componentIndex(root: JsonRecord): ContractParseResult<Map<string, string>> {
  const index = new Map<string, string>();
  const queue: unknown[] = [];
  if (root.components !== undefined) {
    const components = array(root.components);
    if (!components) {
      return { ok: false, issues: [{ path: "components", message: "must be an array" }] };
    }
    queue.push(...components);
  }
  const metadataComponent = record(record(root.metadata)?.component);
  if (metadataComponent) queue.push(metadataComponent);
  let visited = 0;
  while (queue.length > 0) {
    visited++;
    if (visited > MAX_CYCLONEDX_COMPONENTS) {
      return {
        ok: false,
        issues: [
          {
            path: "components",
            message: `must contain at most ${MAX_CYCLONEDX_COMPONENTS} nested components`,
          },
        ],
      };
    }
    const component = record(queue.shift());
    if (!component) continue;
    const ref = string(component["bom-ref"]);
    if (ref) index.set(ref, componentIdentity(component, ref));
    const children = array(component.components);
    if (children) queue.push(...children);
  }
  return { ok: true, value: index };
}

function affectedComponents(
  vulnerability: JsonRecord,
  components: Map<string, string>,
): ContractParseResult<{ identities: string[]; refs: string[] }> {
  if (vulnerability.affects === undefined) return { ok: true, value: { identities: [], refs: [] } };
  const affects = array(vulnerability.affects);
  if (!affects) {
    return { ok: false, issues: [{ path: "affects", message: "must be an array" }] };
  }
  if (affects.length > MAX_CYCLONEDX_AFFECTS) {
    return {
      ok: false,
      issues: [
        { path: "affects", message: `must contain at most ${MAX_CYCLONEDX_AFFECTS} entries` },
      ],
    };
  }
  const refs: string[] = [];
  const identities: string[] = [];
  for (const [index, rawAffect] of affects.entries()) {
    const affect = record(rawAffect);
    const ref = string(affect?.ref);
    if (!ref) {
      return {
        ok: false,
        issues: [{ path: `affects.${index}.ref`, message: "requires a non-empty string" }],
      };
    }
    refs.push(ref);
    identities.push(boundedText(components.get(ref) ?? ref)!);
  }
  return {
    ok: true,
    value: {
      refs: [...new Set(refs)].sort(),
      identities: [...new Set(identities)].sort(),
    },
  };
}

function analysisState(vulnerability: JsonRecord): string | undefined {
  return string(record(vulnerability.analysis)?.state)?.toLowerCase();
}

function findingStatus(vulnerability: JsonRecord): Finding["status"] {
  switch (analysisState(vulnerability)) {
    case "false_positive":
    case "not_affected":
    case "resolved":
    case "resolved_with_pedigree":
      return "not_established";
    default:
      return "hypothesis";
  }
}

function findingConfidence(vulnerability: JsonRecord): Finding["confidence"] {
  const state = analysisState(vulnerability);
  return state === "exploitable" || state === "not_affected" || state === "false_positive"
    ? "high"
    : "medium";
}

function analysisNotes(vulnerability: JsonRecord): string[] {
  const analysis = record(vulnerability.analysis);
  if (!analysis) return [];
  const notes: string[] = [];
  const state = string(analysis.state);
  const justification = string(analysis.justification);
  if (state) notes.push(boundedText(`CycloneDX analysis state: ${state}`)!);
  if (justification) notes.push(boundedText(`CycloneDX justification: ${justification}`)!);
  const responses = array(analysis.response)
    ?.map(string)
    .filter((value): value is string => value !== undefined);
  if (responses && responses.length > 0) {
    notes.push(boundedText(`CycloneDX response: ${responses.join(", ")}`)!);
  }
  return notes.slice(0, 64);
}

function remediation(vulnerability: JsonRecord): string | undefined {
  const recommendation = boundedText(vulnerability.recommendation);
  const workaround = boundedText(vulnerability.workaround);
  if (recommendation && workaround) {
    return boundedText(`${recommendation} Workaround: ${workaround}`);
  }
  return recommendation ?? workaround;
}

function vulnerabilityFinding(
  vulnerability: JsonRecord,
  index: number,
  sourceEvidenceId: string,
  components: Map<string, string>,
): ContractParseResult<Finding> {
  const id = string(vulnerability.id);
  if (!id) {
    return {
      ok: false,
      issues: [{ path: `/vulnerabilities/${index}/id`, message: "requires a non-empty string" }],
    };
  }
  const affected = affectedComponents(vulnerability, components);
  if (!affected.ok) {
    return {
      ok: false,
      issues: affected.issues.map((issue) => ({
        ...issue,
        path: `/vulnerabilities/${index}/${issue.path.replaceAll(".", "/")}`,
      })),
    };
  }
  const severity = vulnerabilitySeverity(vulnerability);
  if (!severity.ok) {
    return {
      ok: false,
      issues: severity.issues.map((issue) => ({
        ...issue,
        path: `/vulnerabilities/${index}/${issue.path.replaceAll(".", "/")}`,
      })),
    };
  }
  const pointer = `/vulnerabilities/${index}`;
  const summary = boundedText(
    vulnerability.description,
    affected.value.identities[0]
      ? `${id} affects ${affected.value.identities[0]}`
      : `CycloneDX vulnerability ${id}`,
  )!;
  const state = analysisState(vulnerability);
  const finding: Finding = {
    id: `cyclonedx-${digest(
      [sourceEvidenceId, id, ...[...affected.value.refs].sort()].join("\0"),
    )}`,
    summary,
    status: findingStatus(vulnerability),
    severity: severity.value,
    confidence: findingConfidence(vulnerability),
    evidence: [{ evidenceId: sourceEvidenceId, locator: { kind: "json_pointer", value: pointer } }],
    affected: affected.value.identities,
    preconditions: analysisNotes(vulnerability),
    ...(boundedText(vulnerability.detail) ? { impact: boundedText(vulnerability.detail) } : {}),
    ...(remediation(vulnerability) ? { remediation: remediation(vulnerability) } : {}),
    verification: boundedText(
      `Verify ${id} against the cited CycloneDX record, the resolved component versions, and the deployed dependency graph${state ? `; review the producer's ${state} analysis state` : ""}.`,
    )!,
    residualRisk:
      "This normalized component-vulnerability assertion does not by itself establish runtime reachability or exploitability.",
  };
  return { ok: true, value: finding };
}

export function normalizeCycloneDx(
  input: NormalizeCycloneDxInput,
): ContractParseResult<FindingSet> {
  let serialized: string;
  try {
    serialized = JSON.stringify(input.cyclonedx);
  } catch {
    return { ok: false, issues: [{ path: "$", message: "must be JSON-serializable" }] };
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_CYCLONEDX_JSON_BYTES) {
    return {
      ok: false,
      issues: [
        { path: "$", message: `must contain at most ${MAX_CYCLONEDX_JSON_BYTES} UTF-8 bytes` },
      ],
    };
  }
  const root = record(input.cyclonedx);
  if (!root) return { ok: false, issues: [{ path: "$", message: "must be an object" }] };
  if (root.bomFormat !== "CycloneDX") {
    return { ok: false, issues: [{ path: "bomFormat", message: "must be 'CycloneDX'" }] };
  }
  const specVersion = string(root.specVersion);
  if (!specVersion || !["1.4", "1.5", "1.6", "1.7"].includes(specVersion)) {
    return {
      ok: false,
      issues: [{ path: "specVersion", message: "must be one of 1.4, 1.5, 1.6, or 1.7" }],
    };
  }
  const vulnerabilities = root.vulnerabilities === undefined ? [] : array(root.vulnerabilities);
  if (!vulnerabilities) {
    return { ok: false, issues: [{ path: "vulnerabilities", message: "must be an array" }] };
  }
  if (vulnerabilities.length > MAX_CYCLONEDX_VULNERABILITIES) {
    return {
      ok: false,
      issues: [
        {
          path: "vulnerabilities",
          message: `must contain at most ${MAX_CYCLONEDX_VULNERABILITIES} entries`,
        },
      ],
    };
  }
  const components = componentIndex(root);
  if (!components.ok) return components;
  const issues: ContractIssue[] = [];
  const findings: Finding[] = [];
  for (const [index, rawVulnerability] of vulnerabilities.entries()) {
    const vulnerability = record(rawVulnerability);
    if (!vulnerability) {
      issues.push({ path: `/vulnerabilities/${index}`, message: "must be an object" });
      continue;
    }
    const normalized = vulnerabilityFinding(
      vulnerability,
      index,
      input.sourceEvidenceId,
      components.value,
    );
    if (normalized.ok) findings.push(normalized.value);
    else issues.push(...normalized.issues);
  }
  if (issues.length > 0) return { ok: false, issues };
  return parseFindingSet({
    schemaVersion: 1,
    findingSetId: `cyclonedx-${digest(
      JSON.stringify({
        evidenceBundleId: input.evidenceBundleId,
        sourceEvidenceId: input.sourceEvidenceId,
        findings,
      }),
    )}`,
    evidenceBundleId: input.evidenceBundleId,
    findings,
  });
}
