import { createHash } from "node:crypto";
import type { ContractIssue, ContractParseResult, Finding, FindingSet } from "./contracts";
import { parseFindingSet } from "./contracts";

export const SARIF_MIME_TYPE = "application/sarif+json";
export const MAX_SARIF_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_SARIF_RUNS = 64;
export const MAX_SARIF_RESULTS = 256;

export interface NormalizeSarifInput {
  evidenceBundleId: string;
  sourceEvidenceId: string;
  sarif: unknown;
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

function messageText(value: unknown): string | undefined {
  const message = record(value);
  return boundedText(message?.text ?? message?.markdown);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function jsonPointer(runIndex: number, resultIndex: number): string {
  return `/runs/${runIndex}/results/${resultIndex}`;
}

function ruleFor(run: JsonRecord, result: JsonRecord): JsonRecord | undefined {
  const rules = array(record(record(run.tool)?.driver)?.rules) ?? [];
  const index = result.ruleIndex;
  if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
    return record(rules[index]);
  }
  const ruleId = string(result.ruleId);
  return ruleId ? rules.map(record).find((rule) => string(rule?.id) === ruleId) : undefined;
}

function securityScore(properties: JsonRecord | undefined): number | undefined {
  const raw = properties?.["security-severity"] ?? properties?.securitySeverity;
  const score = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(score) && score >= 0 && score <= 10 ? score : undefined;
}

function severity(result: JsonRecord, rule: JsonRecord | undefined): Finding["severity"] {
  const score = securityScore(record(result.properties)) ?? securityScore(record(rule?.properties));
  if (score !== undefined) {
    if (score >= 9) return "critical";
    if (score >= 7) return "high";
    if (score >= 4) return "medium";
    if (score > 0) return "low";
    return "informational";
  }
  const defaultLevel = string(record(rule?.defaultConfiguration)?.level);
  switch (string(result.level) ?? defaultLevel) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    case "note":
      return "low";
    default:
      return "informational";
  }
}

function confidence(result: JsonRecord, rule: JsonRecord | undefined): Finding["confidence"] {
  const precision = string(
    record(result.properties)?.precision ?? record(rule?.properties)?.precision,
  )
    ?.toLowerCase()
    .replaceAll("_", "-");
  if (precision === "very-high" || precision === "high") return "high";
  if (precision === "low") return "low";
  return "medium";
}

function regionSuffix(region: JsonRecord | undefined): string {
  const line = region?.startLine;
  const column = region?.startColumn;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return "";
  return typeof column === "number" && Number.isInteger(column) && column >= 1
    ? `:${line}:${column}`
    : `:${line}`;
}

function affectedLocations(result: JsonRecord): string[] {
  const affected: string[] = [];
  for (const rawLocation of array(result.locations) ?? []) {
    const location = record(rawLocation);
    const physical = record(location?.physicalLocation);
    const artifact = record(physical?.artifactLocation);
    const uri = string(artifact?.uri);
    const base = string(artifact?.uriBaseId);
    if (uri)
      affected.push(`${base ? `${base}:` : ""}${uri}${regionSuffix(record(physical?.region))}`);
    for (const rawLogical of array(location?.logicalLocations) ?? []) {
      const logical = record(rawLogical);
      const name = string(logical?.fullyQualifiedName) ?? string(logical?.name);
      if (name) affected.push(name);
    }
  }
  return [...new Set(affected)].slice(0, 64);
}

function remediation(result: JsonRecord, rule: JsonRecord | undefined): string | undefined {
  const help = messageText(rule?.help);
  if (help) return help;
  const firstFix = record((array(result.fixes) ?? [])[0]);
  return messageText(firstFix?.description);
}

function fingerprintIdentity(result: JsonRecord): string[] {
  const fingerprints = record(result.partialFingerprints) ?? record(result.fingerprints);
  if (!fingerprints) return [];
  return Object.entries(fingerprints)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);
}

function resultFinding(
  run: JsonRecord,
  result: JsonRecord,
  runIndex: number,
  resultIndex: number,
  sourceEvidenceId: string,
): ContractParseResult<Finding> {
  const pointer = jsonPointer(runIndex, resultIndex);
  const summary = messageText(result.message);
  if (!summary) {
    return {
      ok: false,
      issues: [{ path: `${pointer}/message`, message: "requires text or markdown" }],
    };
  }
  const rule = ruleFor(run, result);
  const ruleId = string(result.ruleId) ?? string(rule?.id) ?? "unidentified-rule";
  const affected = affectedLocations(result);
  const suppressed = (array(result.suppressions) ?? []).length > 0;
  const fix = remediation(result, rule);
  const fingerprints = fingerprintIdentity(result);
  const identity = digest(
    fingerprints.length > 0
      ? [sourceEvidenceId, ruleId, ...fingerprints].join("\0")
      : [sourceEvidenceId, runIndex, resultIndex, ruleId, summary, ...affected].join("\0"),
  );
  const verificationTarget = affected[0] ? ` at ${affected[0]}` : "";
  const finding: Finding = {
    id: `sarif-${identity}`,
    summary,
    status: suppressed ? "not_established" : "hypothesis",
    severity: severity(result, rule),
    confidence: confidence(result, rule),
    evidence: [
      {
        evidenceId: sourceEvidenceId,
        locator: { kind: "json_pointer", value: pointer },
      },
    ],
    affected,
    preconditions: suppressed ? ["The SARIF producer marked this result as suppressed"] : [],
    ...(fix ? { remediation: fix } : {}),
    verification: boundedText(
      `Inspect rule ${ruleId}${verificationTarget} and validate the cited SARIF result against the current code and threat model.`,
    )!,
    residualRisk:
      "This normalized scanner observation does not by itself establish reachability or exploitability.",
  };
  return { ok: true, value: finding };
}

export function normalizeSarif(input: NormalizeSarifInput): ContractParseResult<FindingSet> {
  let serialized: string;
  try {
    serialized = JSON.stringify(input.sarif);
  } catch {
    return { ok: false, issues: [{ path: "$", message: "must be JSON-serializable" }] };
  }
  if (!serialized) {
    return { ok: false, issues: [{ path: "$", message: "must be a SARIF object" }] };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SARIF_JSON_BYTES) {
    return {
      ok: false,
      issues: [{ path: "$", message: `exceeds ${MAX_SARIF_JSON_BYTES} UTF-8 bytes` }],
    };
  }
  const sarif = record(input.sarif);
  if (!sarif) return { ok: false, issues: [{ path: "$", message: "must be a SARIF object" }] };
  if (sarif.version !== "2.1.0") {
    return { ok: false, issues: [{ path: "version", message: "must be '2.1.0'" }] };
  }
  const runs = array(sarif.runs);
  if (!runs) return { ok: false, issues: [{ path: "runs", message: "must be an array" }] };
  if (runs.length > MAX_SARIF_RUNS) {
    return {
      ok: false,
      issues: [{ path: "runs", message: `must contain at most ${MAX_SARIF_RUNS} runs` }],
    };
  }

  const issues: ContractIssue[] = [];
  const findings: Finding[] = [];
  let resultCount = 0;
  let overResultLimit = false;
  for (const [runIndex, rawRun] of runs.entries()) {
    const run = record(rawRun);
    if (!run) {
      issues.push({ path: `runs.${runIndex}`, message: "must be an object" });
      continue;
    }
    const results = run.results === undefined ? [] : array(run.results);
    if (!results) {
      issues.push({ path: `runs.${runIndex}.results`, message: "must be an array" });
      continue;
    }
    for (const [resultIndex, rawResult] of results.entries()) {
      resultCount++;
      if (resultCount > MAX_SARIF_RESULTS) {
        issues.push({ path: "runs", message: `must contain at most ${MAX_SARIF_RESULTS} results` });
        overResultLimit = true;
        break;
      }
      const result = record(rawResult);
      if (!result) {
        issues.push({
          path: `runs.${runIndex}.results.${resultIndex}`,
          message: "must be an object",
        });
        continue;
      }
      const normalized = resultFinding(run, result, runIndex, resultIndex, input.sourceEvidenceId);
      if (normalized.ok) findings.push(normalized.value);
      else issues.push(...normalized.issues);
    }
    if (overResultLimit) break;
  }
  if (issues.length > 0) return { ok: false, issues };

  return parseFindingSet({
    schemaVersion: 1,
    findingSetId: `sarif-${digest(
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
