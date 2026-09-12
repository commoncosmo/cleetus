import type { ToolResult } from "../tools/types";
import { normalizeCacheKey } from "../web/fetch-cache";
import { classifyTask } from "./coding-task";

export type RetrievalEfficiencyKind = "retrieval" | "data_artifact" | null;

const DATA_ARTIFACT_RE = /\b(?:json|csv|data|results?|forecast)\b/i;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const DOWNLOAD_RE = /\b(?:curl|wget)\b/i;
const FILE_OUTPUT_RE = /(?:^|\s)(?:-o|--output|-O)(?:\s|=)|(?:^|[^>])>{1,2}(?!>)/m;

export interface FetchedJsonEvidence {
  url: string;
  /** False means the runtime may have capped the body before the model saw all of it. */
  fullyVisible: boolean;
}

export interface DownloadRequest {
  urls: string[];
  /** A simple curl/wget command that writes to a destination instead of only filling stdout. */
  writesFile: boolean;
  destination: string | null;
}

/** Narrow task shape used for retrieval guidance. Document/code artifacts such as README edits
 * deliberately stay out: they may need repository inspection. */
export function retrievalEfficiencyKind(input: string): RetrievalEfficiencyKind {
  const taskClass = classifyTask(input);
  if (taskClass === "retrieval") return "retrieval";
  if (taskClass === "artifact" && DATA_ARTIFACT_RE.test(input)) return "data_artifact";
  return null;
}

/** Recency-positioned turn guidance for inexpensive retrieval. It sets evidence-based stopping
 * conditions without imposing an arbitrary model-call ceiling. */
export function retrievalEfficiencyReminder(input: string): string {
  const kind = retrievalEfficiencyKind(input);
  if (kind === "retrieval") {
    return [
      "<system-reminder>Retrieval efficiency: use evidence already present in the conversation.",
      "If discovery is needed, search once to choose a current authoritative source, then fetch",
      "only the source needed to answer. After a successful fetch contains the requested facts,",
      "answer; do not broaden into more searches or API documentation unless the evidence is",
      "missing, conflicting, high-stakes, or the user requested multiple sources. Intermediate",
      "identifiers such as coordinates, record IDs, versions, and source URLs must come from the",
      "user or retrieved evidence—never guess them. Before using a resolved identifier downstream,",
      "confirm its returned entity matches the request. Do not inspect the local repository for a",
      "standalone information lookup.</system-reminder>",
    ].join(" ");
  }
  if (kind === "data_artifact") {
    return [
      "<system-reminder>Data-artifact efficiency: reuse relevant evidence already present in the",
      "conversation. Do not inventory the repository; inspect only the requested destination if",
      "overwrite status matters. Search only when a direct source is not already known, fetch the",
      "minimum data needed, and use save_fetched_json to persist a complete fetched JSON response",
      "without manually reproducing it. For a deliberately transformed or small derived artifact,",
      "write_file remains appropriate. If the fetched result is truncated or exact raw bytes are",
      "otherwise unavailable, one direct download is appropriate. After writing, validate both its",
      "structure and requested identity—not merely that the file exists or contains one expected",
      "key. Intermediate identifiers such as coordinates, record IDs, versions, and source URLs",
      "must come from the user or retrieved evidence—never guess them. Report counts, ranges, units,",
      "and directions only when the saved data proves them; otherwise omit or qualify them.</system-reminder>",
    ].join(" ");
  }
  return "";
}

/** Successful execution is not always successful retrieval. An explicit empty search result is
 * objective evidence that discovery made no progress, so it should inform smart routing without
 * changing the web_search tool's normal, non-error result contract. */
export function retrievalToolMadeProgress(
  kind: RetrievalEfficiencyKind,
  tool: string,
  result: ToolResult,
): boolean {
  if (!result.ok) return false;
  if (
    kind !== null &&
    tool === "web_search" &&
    typeof result.output === "string" &&
    /^\s*\(no results\)\s*$/i.test(result.output)
  ) {
    return false;
  }
  if (
    kind !== null &&
    tool === "web_fetch" &&
    typeof result.output === "string" &&
    fetchedPayloadHasNoData(result.output)
  ) {
    return false;
  }
  return true;
}

const FETCHED_BODY = /<untrusted-web-content\b[^>]*>\s*([\s\S]*?)\s*<\/untrusted-web-content>/i;
const METADATA_ONLY_KEY =
  /^(?:generation_?time(?:_ms)?|elapsed(?:_ms)?|duration(?:_ms)?|execution_?time(?:_ms)?)$/i;

function hasMaterialJsonData(value: unknown, key?: string): boolean {
  if (key && METADATA_ONLY_KEY.test(key)) return false;
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([childKey, child]) =>
      hasMaterialJsonData(child, childKey),
    );
  }
  return true;
}

/** True only for fetched JSON that is objectively empty or contains timing metadata without
 * application data. HTML/prose and malformed JSON are unknown and remain progress. */
export function fetchedPayloadHasNoData(output: string): boolean {
  const body = FETCHED_BODY.exec(output)?.[1]?.trim();
  if (!body || (!body.startsWith("{") && !body.startsWith("["))) return false;
  try {
    return !hasMaterialJsonData(JSON.parse(body));
  } catch {
    return false;
  }
}

/** Recency-positioned correction after an empty discovery result. This is deliberately about
 * provenance for arbitrary identifiers, not any particular domain such as weather or geography. */
export function retrievalMissNudge(
  kind: RetrievalEfficiencyKind,
  tool: string,
  result: ToolResult,
): string | null {
  if (kind === null || tool !== "web_search" || retrievalToolMadeProgress(kind, tool, result)) {
    return null;
  }
  return "RETRIEVAL MISS: This search returned no evidence. Do not invent an intermediate identifier, coordinate, version, URL, or record ID. Use a different evidence-backed discovery path, or state that the requested fact could not be verified.";
}

/** Returning to broad discovery after one completed search contradicts the retrieval turn's
 * search-once execution contract. It is a semantic stall signal for smart routing: unlike an
 * arbitrary loop count, it records a concrete phase regression from source selection back to
 * discovery. Other task classes and non-search tools never trigger it. */
export function retrievalDiscoveryStalled(
  kind: RetrievalEfficiencyKind,
  tool: string,
  completedSearches: number,
): boolean {
  return kind !== null && tool === "web_search" && completedSearches > 0;
}

/** Focus a recovery-tier call on completing retrieval instead of repeating the failed discovery
 * path. This is injected only after an observed phase regression, not on ordinary retrieval. */
export function retrievalRecoveryReminder(): string {
  return [
    "<system-reminder>Retrieval recovery: the prior tier returned to broad discovery after",
    "selected sources failed or proved insufficient. Do not retry blocked, placeholder-only,",
    "historical/monthly, or otherwise mismatched sources. Prefer a current authoritative",
    "machine-readable endpoint when available, resolving any intermediate identifiers from",
    "retrieved evidence. Use only the minimum calls needed and answer as soon as the requested",
    "facts are supported. If no current reliable source can be reached, state that limitation",
    "without filling gaps from general knowledge.</system-reminder>",
  ].join(" ");
}

interface CoordinatePair {
  first: number;
  second: number;
  firstPrecision: number;
  secondPrecision: number;
  literal: string;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function coordinatePairs(value: string): CoordinatePair[] {
  const pairs: CoordinatePair[] = [];
  const source = decoded(value);
  const add = (firstText: string, secondText: string, literal: string): void => {
    const first = Number(firstText);
    const second = Number(secondText);
    if (
      Number.isFinite(first) &&
      Number.isFinite(second) &&
      Math.abs(first) <= 180 &&
      Math.abs(second) <= 180 &&
      (Math.abs(first) <= 90 || Math.abs(second) <= 90)
    ) {
      const precision = (text: string) => text.split(".")[1]?.length ?? 0;
      pairs.push({
        first,
        second,
        firstPrecision: precision(firstText),
        secondPrecision: precision(secondText),
        literal,
      });
    }
  };
  for (const match of source.matchAll(/(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/g)) {
    add(match[1]!, match[2]!, match[0]);
  }
  const named =
    /(?:["']?(?:lat|latitude)["']?\s*[:=]\s*["']?)(-?\d{1,3}\.\d+)["']?[\s\S]{0,120}?(?:["']?(?:lon|lng|longitude)["']?\s*[:=]\s*["']?)(-?\d{1,3}\.\d+)/gi;
  for (const match of source.matchAll(named)) {
    add(match[1]!, match[2]!, match[0]);
  }
  const namedReverse =
    /(?:["']?(?:lon|lng|longitude)["']?\s*[:=]\s*["']?)(-?\d{1,3}\.\d+)["']?[\s\S]{0,120}?(?:["']?(?:lat|latitude)["']?\s*[:=]\s*["']?)(-?\d{1,3}\.\d+)/gi;
  for (const match of source.matchAll(namedReverse)) {
    add(match[1]!, match[2]!, match[0]);
  }
  return pairs;
}

function sameCoordinate(a: CoordinatePair, b: CoordinatePair): boolean {
  // A downstream API URL often uses fewer decimal places than a discovery result. Accept values
  // that are consistent at the requested precision (42.082493 → 42.08), while retaining the
  // existing 0.001° floor for small representation differences.
  const close = (requested: number, evidence: number, requestedPrecision: number) =>
    Math.abs(requested - evidence) <= Math.max(0.001, 0.5 * 10 ** -requestedPrecision) + 1e-12;
  return (
    (close(a.first, b.first, a.firstPrecision) && close(a.second, b.second, a.secondPrecision)) ||
    // GeoJSON commonly supplies longitude,latitude while downstream APIs request
    // latitude,longitude. Reordering an evidence-backed pair is not invention.
    (close(a.first, b.second, a.firstPrecision) && close(a.second, b.first, a.secondPrecision))
  );
}

/** Null means the URL carries no coordinates; otherwise report whether every coordinate pair is
 * grounded in the request or successful current-turn evidence. */
export function retrievalUrlCoordinatesGrounded(
  tool: string,
  args: unknown,
  request: string,
  successfulEvidence: string,
): boolean | null {
  if (tool !== "web_fetch") return null;
  const url = (args as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") return null;
  const requested = coordinatePairs(url);
  if (requested.length === 0) return null;
  const grounded = coordinatePairs(`${request}\n${successfulEvidence}`);
  return requested.every((candidate) =>
    grounded.some((evidence) => sameCoordinate(candidate, evidence)),
  );
}

/** Block coordinate-bearing fetch URLs when the pair came from neither the user nor a successful
 * current-turn tool result. This enforces provenance for arbitrary location lookups without
 * interpreting a provider's nearby-city label as the requested entity. */
export function ungroundedRetrievalCoordinateBlock(
  kind: RetrievalEfficiencyKind,
  tool: string,
  args: unknown,
  request: string,
  successfulEvidence: string,
): string | null {
  if (kind === null || tool !== "web_fetch") return null;
  const url = (args as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") return null;
  const requested = coordinatePairs(url);
  if (requested.length === 0) return null;
  const coordinatesGrounded = retrievalUrlCoordinatesGrounded(
    tool,
    args,
    request,
    successfulEvidence,
  );
  const unsupported = coordinatesGrounded ? undefined : requested[0];
  return unsupported
    ? `Coordinates ${unsupported.literal} were not present in the user request or any successful retrieval evidence. Resolve the location through an evidence-backed source before fetching by coordinates; do not guess intermediate identifiers.`
    : null;
}

/** A short checkpoint placed immediately after a useful web fetch. */
export function retrievalFetchNudge(
  kind: RetrievalEfficiencyKind,
  tool: string,
  resultOk: boolean,
): string | null {
  if (tool !== "web_fetch" || !resultOk || kind === null) return null;
  return kind === "retrieval"
    ? "RETRIEVAL CHECKPOINT: If this source contains the requested facts, answer now. Otherwise fetch only the specifically missing evidence; do not restart broad discovery."
    : "DATA ARTIFACT CHECKPOINT: If the complete requested JSON is present, save its exact cached body with save_fetched_json; do not manually reconstruct a large payload. Use write_file only for an intentionally transformed artifact. Validate structure and identity once. Do not search again; a direct download remains appropriate if this result was truncated.";
}

/** Detect successful web_fetch results whose response body is JSON. */
export function successfulFetchedJsonEvidence(
  tool: string,
  args: unknown,
  result: ToolResult,
  maxVisibleChars = Number.POSITIVE_INFINITY,
): FetchedJsonEvidence | null {
  if (tool !== "web_fetch" || !result.ok || typeof result.output !== "string") return null;
  if (!/<untrusted-web-content\b[^>]*>\s*[\[{]/s.test(result.output)) return null;
  const url = (args as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && url.trim()
    ? { url: normalizeCacheKey(url), fullyVisible: result.output.length <= maxVisibleChars }
    : null;
}

/** Back-compatible convenience for callers that require a fully visible JSON body. */
export function successfulFetchedJsonUrl(
  tool: string,
  args: unknown,
  result: ToolResult,
  maxVisibleChars = Number.POSITIVE_INFINITY,
): string | null {
  const evidence = successfulFetchedJsonEvidence(tool, args, result, maxVisibleChars);
  return evidence?.fullyVisible ? evidence.url : null;
}

/** Parse only the narrow, observable curl/wget forms used for data downloads. This is not a
 * general shell parser: ambiguous pipelines and substitutions deliberately produce no
 * destination, leaving the command alone. */
export function downloadRequest(tool: string, args: unknown): DownloadRequest | null {
  if (tool !== "bash") return null;
  const command = (args as { command?: unknown } | undefined)?.command;
  if (typeof command !== "string" || !DOWNLOAD_RE.test(command)) return null;
  const urls = [...command.matchAll(URL_RE)].map((match) => normalizeCacheKey(match[0]));
  if (urls.length === 0) return null;
  const writesFile = FILE_OUTPUT_RE.test(command);
  let destination: string | null = null;
  if (writesFile && !/[|`]|\$\(/.test(command)) {
    const option = command.match(
      /(?:^|\s)(?:-o|--output|-O)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s;&]+))/,
    );
    const redirect = command.match(/>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&]+))/);
    destination =
      option?.[1] ??
      option?.[2] ??
      option?.[3] ??
      redirect?.[1] ??
      redirect?.[2] ??
      redirect?.[3] ??
      null;
  }
  return { urls, writesFile, destination };
}

/** Block repeated JSON retrieval proven by current-turn evidence. A capped web_fetch may be
 * followed by one direct-to-file download for exact bytes, but repeating it into stdout merely
 * incurs the same cap again and is never useful. */
export function redundantFetchedJsonDownloadBlock(
  tool: string,
  args: unknown,
  fetchedJsonUrls: ReadonlySet<string>,
  fullyVisibleFetchedJsonUrls: ReadonlySet<string> = fetchedJsonUrls,
  directlyDownloadedJsonUrls: ReadonlySet<string> = new Set(),
): string | null {
  const request = downloadRequest(tool, args);
  if (!request) return null;
  const repeatedDirect = request.urls.find((url) => directlyDownloadedJsonUrls.has(url));
  if (repeatedDirect) {
    return "This JSON URL was already downloaded directly during this turn. Reuse and validate the existing destination; do not download the same payload again.";
  }
  const fetched = request.urls.find((url) => fetchedJsonUrls.has(url));
  if (!fetched) return null;
  if (!request.writesFile) {
    return fullyVisibleFetchedJsonUrls.has(fetched)
      ? "This JSON URL was already fetched successfully during this turn. Reuse the prior web_fetch result; repeating it through curl or wget only duplicates context."
      : "This JSON URL was already fetched but its body may have been capped. If exact raw bytes are required, download it once directly to the requested destination; do not repeat it into stdout where it will be capped again.";
  }
  if (!fullyVisibleFetchedJsonUrls.has(fetched)) return null;
  return "This JSON URL was already fetched successfully during this turn. Reuse the JSON in the prior web_fetch result and save it with write_file; do not download the same payload again through bash.";
}

/** Course-correct repository inventory that cannot help a standalone data export. */
export function dataArtifactInventoryNudge(
  kind: RetrievalEfficiencyKind,
  tool: string,
  args: unknown,
): string | null {
  if (kind !== "data_artifact") return null;
  if (tool === "glob" || tool === "grep") {
    return "DATA ARTIFACT COURSE CORRECTION: Repository inventory is not needed for this standalone export. Obtain or reuse the requested data, write the destination, validate it once, and finish.";
  }
  if (tool !== "bash") return null;
  const command = (args as { command?: unknown } | undefined)?.command;
  if (
    typeof command === "string" &&
    /^\s*(?:ls|find|tree|rg)(?:\s|$)/i.test(command) &&
    !/[>|]/.test(command)
  ) {
    return "DATA ARTIFACT COURSE CORRECTION: Repository inventory is not needed for this standalone export. Obtain or reuse the requested data, write the destination, validate it once, and finish.";
  }
  return null;
}
