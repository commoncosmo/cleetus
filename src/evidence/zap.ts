import { createHash } from "node:crypto";
import type { ContractIssue, ContractParseResult, Finding, FindingSet } from "./contracts";
import { parseFindingSet } from "./contracts";

export const ZAP_JSON_MIME_TYPE = "application/json";
export const MAX_ZAP_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_ZAP_SITES = 32;
export const MAX_ZAP_ALERTS = 256;
export const MAX_ZAP_INSTANCES_PER_ALERT = 64;
export const MAX_ZAP_INSTANCES = 1_024;

export interface NormalizeZapPassiveInput {
  evidenceBundleId: string;
  sourceEvidenceId: string;
  declaredTarget: string;
  zap: unknown;
}

type JsonRecord = Record<string, unknown>;

interface NormalizedInstance {
  identity: string;
  pointer: string;
}

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

function plainText(value: unknown, fallback?: string): string | undefined {
  const raw = string(value);
  const text = raw
    ? raw
        .replace(/<[^>]*>/gu, " ")
        .replace(/&nbsp;/giu, " ")
        .replace(/&amp;/giu, "&")
        .replace(/&lt;/giu, "<")
        .replace(/&gt;/giu, ">")
        .replace(/&quot;/giu, '"')
        .replace(/&#39;/giu, "'")
        .replace(/\s+/gu, " ")
        .trim()
    : fallback;
  if (!text) return undefined;
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function integerString(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function riskSeverity(value: unknown): ContractParseResult<Finding["severity"]> {
  const code = integerString(value);
  switch (code) {
    case -1:
    case 0:
      return { ok: true, value: "informational" };
    case 1:
      return { ok: true, value: "low" };
    case 2:
      return { ok: true, value: "medium" };
    case 3:
      return { ok: true, value: "high" };
    default:
      return {
        ok: false,
        issues: [{ path: "riskcode", message: "must be a ZAP risk code from -1 through 3" }],
      };
  }
}

function alertConfidence(value: unknown): ContractParseResult<Finding["confidence"]> {
  const code = integerString(value);
  switch (code) {
    case 0:
    case 1:
      return { ok: true, value: "low" };
    case 2:
      return { ok: true, value: "medium" };
    case 3:
    case 4:
      return { ok: true, value: "high" };
    default:
      return {
        ok: false,
        issues: [{ path: "confidence", message: "must be a ZAP confidence code from 0 through 4" }],
      };
  }
}

function confidenceLabel(value: unknown): string {
  switch (integerString(value)) {
    case 0:
      return "false positive";
    case 1:
      return "low";
    case 2:
      return "medium";
    case 3:
      return "high";
    case 4:
      return "confirmed by ZAP";
    default:
      return "unknown";
  }
}

function alertStatus(alert: JsonRecord): Finding["status"] {
  return integerString(alert.riskcode) === -1 || integerString(alert.confidence) === 0
    ? "not_established"
    : "hypothesis";
}

function normalizeInstances(
  alert: JsonRecord,
  siteIndex: number,
  alertIndex: number,
): ContractParseResult<NormalizedInstance[]> {
  const instances = array(alert.instances);
  if (!instances) {
    return { ok: false, issues: [{ path: "instances", message: "must be an array" }] };
  }
  if (instances.length > MAX_ZAP_INSTANCES_PER_ALERT) {
    return {
      ok: false,
      issues: [
        {
          path: "instances",
          message: `must contain at most ${MAX_ZAP_INSTANCES_PER_ALERT} entries`,
        },
      ],
    };
  }
  const normalized: NormalizedInstance[] = [];
  for (const [instanceIndex, rawInstance] of instances.entries()) {
    const instance = record(rawInstance);
    const uri = string(instance?.uri);
    if (!instance || !uri) {
      return {
        ok: false,
        issues: [
          {
            path: `instances.${instanceIndex}.uri`,
            message: "requires an instance object with a non-empty URI",
          },
        ],
      };
    }
    const method = string(instance.method)?.toUpperCase();
    const parameter = plainText(instance.param);
    const identity = plainText(
      `${method ? `${method} ` : ""}${uri}${parameter ? ` (parameter: ${parameter})` : ""}`,
    )!;
    normalized.push({
      identity,
      pointer: `/site/${siteIndex}/alerts/${alertIndex}/instances/${instanceIndex}`,
    });
  }
  return { ok: true, value: normalized };
}

function alertFinding(input: {
  alert: JsonRecord;
  siteName: string;
  siteIndex: number;
  alertIndex: number;
  instances: NormalizedInstance[];
  sourceEvidenceId: string;
  declaredTarget: string;
}): ContractParseResult<Finding> {
  const reference = string(input.alert.alertRef) ?? string(input.alert.pluginid);
  if (!reference) {
    return {
      ok: false,
      issues: [{ path: "alertRef", message: "requires alertRef or pluginid" }],
    };
  }
  const summary = plainText(input.alert.name ?? input.alert.alert);
  if (!summary) {
    return { ok: false, issues: [{ path: "name", message: "requires name or alert" }] };
  }
  const severity = riskSeverity(input.alert.riskcode);
  if (!severity.ok) return severity;
  const confidence = alertConfidence(input.alert.confidence);
  if (!confidence.ok) return confidence;
  const affected = [...new Set(input.instances.map((instance) => instance.identity))].sort();
  const instancePointers = input.instances.map((instance) => instance.pointer);
  const alertPointer = `/site/${input.siteIndex}/alerts/${input.alertIndex}`;
  const evidence = (instancePointers.length > 0 ? instancePointers : [alertPointer]).map(
    (value) => ({
      evidenceId: input.sourceEvidenceId,
      locator: { kind: "json_pointer" as const, value },
    }),
  );
  const target = plainText(input.declaredTarget)!;
  const preconditions = [
    plainText(`Client job declared passive-network execution for target ${target}`)!,
    plainText(`ZAP confidence: ${confidenceLabel(input.alert.confidence)}`)!,
  ];
  if (input.alert.systemic === true || input.alert.systemic === "true") {
    preconditions.push("ZAP marked this alert as systemic");
  }
  const description = plainText(input.alert.desc);
  const solution = plainText(input.alert.solution);
  const cwe = integerString(input.alert.cweid);
  return {
    ok: true,
    value: {
      id: `zap-${digest(
        [input.sourceEvidenceId, input.siteName, reference, ...affected].join("\0"),
      )}`,
      summary,
      status: alertStatus(input.alert),
      severity: severity.value,
      confidence: confidence.value,
      evidence,
      affected: affected.length > 0 ? affected : [plainText(input.siteName)!],
      preconditions,
      ...(description ? { impact: description } : {}),
      ...(solution ? { remediation: solution } : {}),
      verification: plainText(
        `Review ZAP alert ${reference}${cwe && cwe > 0 ? ` (CWE-${cwe})` : ""} against the cited request metadata and application code. Reproduce only within the approved target and without escalating to active testing unless separately authorized.`,
      )!,
      residualRisk:
        "Passive DAST observes only traffic and responses it sees; unvisited routes, authenticated states, and exploitability remain unestablished.",
    },
  };
}

export function normalizeZapPassive(
  input: NormalizeZapPassiveInput,
): ContractParseResult<FindingSet> {
  let serialized: string;
  try {
    serialized = JSON.stringify(input.zap);
  } catch {
    return { ok: false, issues: [{ path: "$", message: "must be JSON-serializable" }] };
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_ZAP_JSON_BYTES) {
    return {
      ok: false,
      issues: [{ path: "$", message: `must contain at most ${MAX_ZAP_JSON_BYTES} UTF-8 bytes` }],
    };
  }
  const declaredTarget = plainText(input.declaredTarget);
  if (!declaredTarget) {
    return {
      ok: false,
      issues: [{ path: "declaredTarget", message: "requires the authorized passive job target" }],
    };
  }
  const root = record(input.zap);
  if (!root) return { ok: false, issues: [{ path: "$", message: "must be an object" }] };
  const programName = string(root["@programName"]);
  if (!programName || !/\bZAP\b/iu.test(programName)) {
    return {
      ok: false,
      issues: [{ path: "@programName", message: "must identify an OWASP ZAP report" }],
    };
  }
  const sites = array(root.site);
  if (!sites) return { ok: false, issues: [{ path: "site", message: "must be an array" }] };
  if (sites.length > MAX_ZAP_SITES) {
    return {
      ok: false,
      issues: [{ path: "site", message: `must contain at most ${MAX_ZAP_SITES} sites` }],
    };
  }

  const issues: ContractIssue[] = [];
  const findings: Finding[] = [];
  let alertCount = 0;
  let instanceCount = 0;
  for (const [siteIndex, rawSite] of sites.entries()) {
    const site = record(rawSite);
    const siteName = string(site?.["@name"]);
    if (!site || !siteName) {
      issues.push({ path: `/site/${siteIndex}/@name`, message: "requires a non-empty string" });
      continue;
    }
    const alerts = array(site.alerts);
    if (!alerts) {
      issues.push({ path: `/site/${siteIndex}/alerts`, message: "must be an array" });
      continue;
    }
    for (const [alertIndex, rawAlert] of alerts.entries()) {
      alertCount++;
      if (alertCount > MAX_ZAP_ALERTS) {
        issues.push({ path: "site", message: `must contain at most ${MAX_ZAP_ALERTS} alerts` });
        break;
      }
      const alert = record(rawAlert);
      if (!alert) {
        issues.push({
          path: `/site/${siteIndex}/alerts/${alertIndex}`,
          message: "must be an object",
        });
        continue;
      }
      const instances = normalizeInstances(alert, siteIndex, alertIndex);
      if (!instances.ok) {
        issues.push(
          ...instances.issues.map((issue) => ({
            ...issue,
            path: `/site/${siteIndex}/alerts/${alertIndex}/${issue.path.replaceAll(".", "/")}`,
          })),
        );
        continue;
      }
      instanceCount += instances.value.length;
      if (instanceCount > MAX_ZAP_INSTANCES) {
        issues.push({
          path: "site",
          message: `must contain at most ${MAX_ZAP_INSTANCES} alert instances`,
        });
        break;
      }
      const finding = alertFinding({
        alert,
        siteName,
        siteIndex,
        alertIndex,
        instances: instances.value,
        sourceEvidenceId: input.sourceEvidenceId,
        declaredTarget,
      });
      if (finding.ok) findings.push(finding.value);
      else {
        issues.push(
          ...finding.issues.map((issue) => ({
            ...issue,
            path: `/site/${siteIndex}/alerts/${alertIndex}/${issue.path}`,
          })),
        );
      }
    }
    if (alertCount > MAX_ZAP_ALERTS || instanceCount > MAX_ZAP_INSTANCES) break;
  }
  if (issues.length > 0) return { ok: false, issues };
  return parseFindingSet({
    schemaVersion: 1,
    findingSetId: `zap-${digest(
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
