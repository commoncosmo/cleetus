import { createHash } from "node:crypto";
import type { ContractIssue, ContractParseResult, Finding, FindingSet } from "./contracts";
import { parseFindingSet } from "./contracts";

export const OSV_SCANNER_JSON_MIME_TYPE = "application/json";
export const MAX_OSV_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_OSV_RESULTS = 64;
export const MAX_OSV_PACKAGES = 256;
export const MAX_OSV_VULNERABILITIES = 256;
export const MAX_OSV_GROUPS = 256;
export const MAX_OSV_GROUP_IDS = 64;

export interface NormalizeOsvInput {
  evidenceBundleId: string;
  sourceEvidenceId: string;
  osv: unknown;
}

type JsonRecord = Record<string, unknown>;

interface VulnerabilityEntry {
  index: number;
  value: JsonRecord;
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
    case "negligible":
    case "none":
    case "unknown":
      return "informational";
    default:
      return undefined;
  }
}

function packageIdentity(pkg: JsonRecord): string | undefined {
  const purl = string(pkg.purl);
  if (purl) return purl;
  const name = string(pkg.name);
  if (!name) return undefined;
  const ecosystem = string(pkg.ecosystem);
  const version = string(pkg.version) ?? string(pkg.commit);
  return `${ecosystem ? `${ecosystem}:` : ""}${name}${version ? `@${version}` : ""}`;
}

function matchingAffected(vulnerability: JsonRecord, pkg: JsonRecord): JsonRecord[] {
  const packageName = string(pkg.name);
  const ecosystem = string(pkg.ecosystem);
  return (array(vulnerability.affected) ?? [])
    .map(record)
    .filter((affected): affected is JsonRecord => {
      if (!affected) return false;
      const affectedPackage = record(affected.package);
      const name = string(affectedPackage?.name);
      const affectedEcosystem = string(affectedPackage?.ecosystem);
      return (
        (!name || !packageName || name === packageName) &&
        (!affectedEcosystem || !ecosystem || affectedEcosystem === ecosystem)
      );
    });
}

function fixedVersions(vulnerabilities: VulnerabilityEntry[], pkg: JsonRecord): string[] {
  const fixed = new Set<string>();
  for (const entry of vulnerabilities) {
    for (const affected of matchingAffected(entry.value, pkg)) {
      for (const rawRange of array(affected.ranges) ?? []) {
        const range = record(rawRange);
        for (const rawEvent of array(range?.events) ?? []) {
          const value = string(record(rawEvent)?.fixed);
          if (value) fixed.add(value);
        }
      }
    }
  }
  return [...fixed].sort().slice(0, 16);
}

function advisorySeverity(
  vulnerabilities: VulnerabilityEntry[],
  pkg: JsonRecord,
): Finding["severity"] {
  let selected: Finding["severity"] = "informational";
  const consider = (candidate: Finding["severity"] | undefined) => {
    if (candidate && severityRank(candidate) > severityRank(selected)) selected = candidate;
  };
  for (const entry of vulnerabilities) {
    const vulnerability = entry.value;
    consider(namedSeverity(record(vulnerability.database_specific)?.severity));
    consider(scoreSeverity(record(record(vulnerability.database_specific)?.cvss)?.score));
    for (const affected of matchingAffected(vulnerability, pkg)) {
      consider(namedSeverity(record(affected.ecosystem_specific)?.severity));
      consider(namedSeverity(record(affected.database_specific)?.severity));
    }
  }
  return selected;
}

function groupIds(group: JsonRecord, path: string): ContractParseResult<string[]> {
  const rawIds = array(group.ids);
  if (!rawIds) return { ok: false, issues: [{ path: `${path}/ids`, message: "must be an array" }] };
  if (rawIds.length < 1 || rawIds.length > MAX_OSV_GROUP_IDS) {
    return {
      ok: false,
      issues: [
        {
          path: `${path}/ids`,
          message: `must contain between 1 and ${MAX_OSV_GROUP_IDS} identifiers`,
        },
      ],
    };
  }
  const ids: string[] = [];
  for (const [index, rawId] of rawIds.entries()) {
    const id = string(rawId);
    if (!id) {
      return {
        ok: false,
        issues: [{ path: `${path}/ids/${index}`, message: "must be a non-empty string" }],
      };
    }
    ids.push(id);
  }
  return { ok: true, value: [...new Set(ids)].sort() };
}

function callState(group: JsonRecord | undefined, ids: string[]): boolean | undefined {
  const analyses = record(group?.analysis) ?? record(group?.experimentalAnalysis);
  const states = ids
    .map((id) => record(analyses?.[id])?.called)
    .filter((value): value is boolean => typeof value === "boolean");
  if (states.some(Boolean)) return true;
  return states.length > 0 ? false : undefined;
}

function groupSeverity(
  group: JsonRecord | undefined,
  vulnerabilities: VulnerabilityEntry[],
  pkg: JsonRecord,
): Finding["severity"] {
  return scoreSeverity(group?.maxSeverity) ?? advisorySeverity(vulnerabilities, pkg);
}

function canonicalId(ids: string[]): string {
  return ids.find((id) => /^CVE-/iu.test(id)) ?? ids.find((id) => /^GHSA-/iu.test(id)) ?? ids[0]!;
}

function vulnerabilityFinding(input: {
  vulnerabilities: VulnerabilityEntry[];
  ids: string[];
  group?: JsonRecord;
  pkg: JsonRecord;
  packageIdentity: string;
  sourcePath?: string;
  resultIndex: number;
  packageIndex: number;
  sourceEvidenceId: string;
}): Finding {
  const ordered = [...input.vulnerabilities].sort((left, right) =>
    string(left.value.id)!.localeCompare(string(right.value.id)!),
  );
  const primary =
    ordered.find((entry) => string(entry.value.id) === canonicalId(input.ids)) ?? ordered[0]!;
  const id = canonicalId(input.ids);
  const target = boundedText(
    input.sourcePath
      ? `${input.packageIdentity} (source: ${input.sourcePath})`
      : input.packageIdentity,
  )!;
  const called = callState(input.group, input.ids);
  const withdrawn = input.vulnerabilities.every((entry) => string(entry.value.withdrawn));
  const fixed = fixedVersions(input.vulnerabilities, input.pkg);
  const evidence = input.vulnerabilities
    .map((entry) => ({
      evidenceId: input.sourceEvidenceId,
      locator: {
        kind: "json_pointer" as const,
        value: `/results/${input.resultIndex}/packages/${input.packageIndex}/vulnerabilities/${entry.index}`,
      },
    }))
    .slice(0, 128);
  const summary = boundedText(primary.value.summary, `${id} affects ${input.packageIdentity}`)!;
  const details = boundedText(primary.value.details);
  const preconditions: string[] = [];
  if (called === false) {
    preconditions.push("OSV-Scanner call analysis did not observe the affected code path");
  } else if (called === true) {
    preconditions.push("OSV-Scanner call analysis observed the affected code path");
  }
  if (withdrawn) preconditions.push("Every grouped OSV record is withdrawn");
  return {
    id: `osv-${digest(
      [
        input.sourceEvidenceId,
        input.sourcePath ?? "",
        input.packageIdentity,
        ...[...input.ids].sort(),
      ].join("\0"),
    )}`,
    summary,
    status: withdrawn || called === false ? "not_established" : "hypothesis",
    severity: groupSeverity(input.group, input.vulnerabilities, input.pkg),
    confidence: called === true ? "high" : "medium",
    evidence,
    affected: [target],
    preconditions,
    ...(details ? { impact: details } : {}),
    ...(fixed.length > 0
      ? {
          remediation: boundedText(
            `Upgrade ${input.packageIdentity} to a fixed version: ${fixed.join(", ")}.`,
          ),
        }
      : {}),
    verification: boundedText(
      `Verify ${id} against the cited OSV-Scanner records, the resolved package version, and the deployed dependency graph.`,
    )!,
    residualRisk:
      "This normalized dependency match does not by itself establish runtime reachability or exploitability.",
  };
}

export function normalizeOsv(input: NormalizeOsvInput): ContractParseResult<FindingSet> {
  let serialized: string;
  try {
    serialized = JSON.stringify(input.osv);
  } catch {
    return { ok: false, issues: [{ path: "$", message: "must be JSON-serializable" }] };
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_OSV_JSON_BYTES) {
    return {
      ok: false,
      issues: [{ path: "$", message: `must contain at most ${MAX_OSV_JSON_BYTES} UTF-8 bytes` }],
    };
  }
  const root = record(input.osv);
  if (!root) return { ok: false, issues: [{ path: "$", message: "must be an object" }] };
  const results = array(root.results);
  if (!results) return { ok: false, issues: [{ path: "results", message: "must be an array" }] };
  if (results.length > MAX_OSV_RESULTS) {
    return {
      ok: false,
      issues: [{ path: "results", message: `must contain at most ${MAX_OSV_RESULTS} entries` }],
    };
  }

  const issues: ContractIssue[] = [];
  const findings: Finding[] = [];
  let packageCount = 0;
  let vulnerabilityCount = 0;
  let groupCount = 0;
  for (const [resultIndex, rawResult] of results.entries()) {
    const result = record(rawResult);
    if (!result) {
      issues.push({ path: `/results/${resultIndex}`, message: "must be an object" });
      continue;
    }
    const packages = array(result.packages);
    if (!packages) {
      issues.push({ path: `/results/${resultIndex}/packages`, message: "must be an array" });
      continue;
    }
    const source = record(result.source);
    const sourcePath = boundedText(source?.path);
    for (const [packageIndex, rawPackageResult] of packages.entries()) {
      packageCount++;
      if (packageCount > MAX_OSV_PACKAGES) {
        issues.push({
          path: "results",
          message: `must contain at most ${MAX_OSV_PACKAGES} packages`,
        });
        break;
      }
      const packageResult = record(rawPackageResult);
      const pkg = record(packageResult?.package);
      const identity = pkg ? packageIdentity(pkg) : undefined;
      if (!packageResult || !pkg || !identity) {
        issues.push({
          path: `/results/${resultIndex}/packages/${packageIndex}/package/name`,
          message: "requires a package object with a non-empty name or purl",
        });
        continue;
      }
      const rawVulnerabilities =
        packageResult.vulnerabilities === undefined ? [] : array(packageResult.vulnerabilities);
      if (!rawVulnerabilities) {
        issues.push({
          path: `/results/${resultIndex}/packages/${packageIndex}/vulnerabilities`,
          message: "must be an array",
        });
        continue;
      }
      const vulnerabilities: VulnerabilityEntry[] = [];
      for (const [vulnerabilityIndex, rawVulnerability] of rawVulnerabilities.entries()) {
        vulnerabilityCount++;
        if (vulnerabilityCount > MAX_OSV_VULNERABILITIES) {
          issues.push({
            path: "results",
            message: `must contain at most ${MAX_OSV_VULNERABILITIES} vulnerabilities`,
          });
          break;
        }
        const vulnerability = record(rawVulnerability);
        if (!vulnerability || !string(vulnerability.id)) {
          issues.push({
            path: `/results/${resultIndex}/packages/${packageIndex}/vulnerabilities/${vulnerabilityIndex}/id`,
            message: "requires an object with a non-empty id",
          });
          continue;
        }
        vulnerabilities.push({ index: vulnerabilityIndex, value: vulnerability });
      }
      if (vulnerabilityCount > MAX_OSV_VULNERABILITIES) break;

      const byId = new Map<string, VulnerabilityEntry[]>();
      for (const vulnerability of vulnerabilities) {
        const id = string(vulnerability.value.id)!;
        byId.set(id, [...(byId.get(id) ?? []), vulnerability]);
      }
      const consumed = new Set<VulnerabilityEntry>();
      const groups = packageResult.groups === undefined ? [] : array(packageResult.groups);
      if (!groups) {
        issues.push({
          path: `/results/${resultIndex}/packages/${packageIndex}/groups`,
          message: "must be an array",
        });
        continue;
      }
      for (const [groupIndex, rawGroup] of groups.entries()) {
        groupCount++;
        if (groupCount > MAX_OSV_GROUPS) {
          issues.push({
            path: "results",
            message: `must contain at most ${MAX_OSV_GROUPS} vulnerability groups`,
          });
          break;
        }
        const group = record(rawGroup);
        const groupPath = `/results/${resultIndex}/packages/${packageIndex}/groups/${groupIndex}`;
        if (!group) {
          issues.push({ path: groupPath, message: "must be an object" });
          continue;
        }
        const parsedIds = groupIds(group, groupPath);
        if (!parsedIds.ok) {
          issues.push(...parsedIds.issues);
          continue;
        }
        const grouped = parsedIds.value.flatMap((id) => byId.get(id) ?? []);
        if (grouped.length === 0) continue;
        for (const entry of grouped) consumed.add(entry);
        findings.push(
          vulnerabilityFinding({
            vulnerabilities: grouped,
            ids: parsedIds.value,
            group,
            pkg,
            packageIdentity: identity,
            sourcePath,
            resultIndex,
            packageIndex,
            sourceEvidenceId: input.sourceEvidenceId,
          }),
        );
      }
      if (groupCount > MAX_OSV_GROUPS) break;
      for (const vulnerability of vulnerabilities) {
        if (consumed.has(vulnerability)) continue;
        const id = string(vulnerability.value.id)!;
        findings.push(
          vulnerabilityFinding({
            vulnerabilities: [vulnerability],
            ids: [id],
            pkg,
            packageIdentity: identity,
            sourcePath,
            resultIndex,
            packageIndex,
            sourceEvidenceId: input.sourceEvidenceId,
          }),
        );
      }
    }
    if (
      packageCount > MAX_OSV_PACKAGES ||
      vulnerabilityCount > MAX_OSV_VULNERABILITIES ||
      groupCount > MAX_OSV_GROUPS
    )
      break;
  }
  if (issues.length > 0) return { ok: false, issues };
  if (findings.length > MAX_OSV_VULNERABILITIES) {
    return {
      ok: false,
      issues: [
        { path: "results", message: `normalizes to at most ${MAX_OSV_VULNERABILITIES} findings` },
      ],
    };
  }
  return parseFindingSet({
    schemaVersion: 1,
    findingSetId: `osv-${digest(
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
