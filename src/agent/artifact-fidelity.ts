const EXACT_RETRIEVAL_RE =
  /\b(?:retrieve|fetch|download|get|pull)\b[\s\S]*\b(?:save|write|store)\b/i;
const TRANSFORM_RE =
  /\b(?:summar(?:y|ize)|transform|convert|extract|select|filter|subset|only\s+(?:the|these)|fields?|columns?)\b/i;
const IDENTITY_STOP_WORDS = new Set([
  "do",
  "current",
  "data",
  "exact",
  "fetch",
  "file",
  "forecast",
  "get",
  "json",
  "pull",
  "retrieve",
  "save",
  "source",
  "store",
  "tests",
  "the",
  "weather",
  "write",
]);

/** True when the request asks to persist retrieved data itself, rather than a transformed view. */
export function expectsExactFetchedArtifact(input: string): boolean {
  return EXACT_RETRIEVAL_RE.test(input) && !TRANSFORM_RE.test(input);
}

/** Parse a JSON body from web_fetch's provenance envelope. The returned value is useful for
 * structural comparison; the raw body is retained so a purpose-built tool can save exact bytes. */
export function fetchedJsonBody(
  output: string | undefined,
): { raw: string; value: unknown } | null {
  if (!output) return null;
  const match = output.match(
    /<untrusted-web-content\b[^>]*>\s*([\s\S]*?)\s*<\/untrusted-web-content>/,
  );
  if (!match) return null;
  const raw = match[1]!.trim();
  if (raw.endsWith("[truncated]")) return null;
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/** Complete JSON URLs retained in a bounded prior-turn evidence packet, in observation order. */
export function fetchedJsonUrlsFromEvidence(evidence: string): string[] {
  const urls: string[] = [];
  for (const match of evidence.matchAll(
    /<untrusted-web-content\b[^>]*\burl="([^"]+)"[^>]*>[\s\S]*?<\/untrusted-web-content>/g,
  )) {
    if (fetchedJsonBody(match[0])) urls.push(match[1]!);
  }
  return urls;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Best deterministic entity anchor available in a typical artifact request. This is deliberately
 * conservative: if no distinctive term can be isolated, the identity gate remains advisory. */
export function artifactIdentityAnchor(request: string): string | null {
  const contextual =
    request.match(/\b(?:for|about|of)\s+(?:the\s+)?([A-Za-z][\w'-]{2,})\b/i)?.[1] ??
    request.match(/\b(?:the\s+)?([A-Za-z][\w'-]{2,})\s+(?:weather|forecast|data)\b/i)?.[1];
  if (contextual && !IDENTITY_STOP_WORDS.has(contextual.toLowerCase())) return contextual;
  const proper = request.match(/\b[A-Z][A-Za-z0-9'-]{2,}\b/g) ?? [];
  return proper.find((term) => !IDENTITY_STOP_WORDS.has(term.toLowerCase())) ?? null;
}

/** Whether an exact fetched artifact has evidence tying its source to the requested entity.
 * Grounded coordinates and evidence-provided endpoints cover machine APIs whose response bodies
 * omit place names; an explicit request anchor in the URL/body covers self-identifying sources. */
export function fetchedArtifactIdentityGrounded(input: {
  request: string;
  url: string;
  raw: string;
  priorEvidence: string;
  coordinatesGrounded: boolean;
}): boolean {
  if (input.coordinatesGrounded) return true;
  const url = decoded(input.url);
  const evidence = decoded(input.priorEvidence);
  if (input.request.includes(input.url) || evidence.includes(input.url) || evidence.includes(url)) {
    return true;
  }
  const anchor = artifactIdentityAnchor(input.request);
  if (!anchor) return true;
  const identityHaystack = `${url}\n${input.raw}`.toLowerCase();
  return identityHaystack.includes(anchor.toLowerCase());
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Bounded, path-oriented differences between fetched JSON and a destination. It intentionally
 * reports array length before element differences—the common large-model-copy failure is a
 * syntactically valid array with silently omitted records. */
export function jsonFidelityIssues(source: unknown, destination: unknown, limit = 8): string[] {
  const issues: string[] = [];
  const visit = (expected: unknown, actual: unknown, path: string): void => {
    if (issues.length >= limit) return;
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) {
        issues.push(`${path}: source is an array but destination is ${describe(actual)}`);
        return;
      }
      if (expected.length !== actual.length) {
        issues.push(
          `${path}: source array has ${expected.length} items; destination has ${actual.length}`,
        );
      }
      for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
        visit(expected[i], actual[i], `${path}[${i}]`);
        if (issues.length >= limit) return;
      }
      return;
    }
    if (expected && typeof expected === "object") {
      if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
        issues.push(`${path}: source is an object but destination is ${describe(actual)}`);
        return;
      }
      const expectedRecord = expected as Record<string, unknown>;
      const actualRecord = actual as Record<string, unknown>;
      for (const key of Object.keys(expectedRecord)) {
        if (!(key in actualRecord)) {
          issues.push(`${path}.${key}: missing from destination`);
        } else {
          visit(expectedRecord[key], actualRecord[key], `${path}.${key}`);
        }
        if (issues.length >= limit) return;
      }
      for (const key of Object.keys(actualRecord)) {
        if (!(key in expectedRecord)) issues.push(`${path}.${key}: not present in source`);
        if (issues.length >= limit) return;
      }
      return;
    }
    if (!Object.is(expected, actual)) {
      issues.push(
        `${path}: source value ${JSON.stringify(expected)} differs from destination ${JSON.stringify(actual)}`,
      );
    }
  };
  visit(source, destination, "$");
  return issues;
}

export function parseJsonDestination(content: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(content) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
