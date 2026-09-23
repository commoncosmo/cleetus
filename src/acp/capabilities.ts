export const ACP_PROTOCOL_VERSION = 1;

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ClientJobCapabilities {
  version: 1;
  kinds: string[];
  maxArtifactReadBytes: number;
}

export const DEFAULT_JOB_ARTIFACT_READ_BYTES = 16_384;
export const MAX_JOB_ARTIFACT_READ_BYTES = 65_536;

export function negotiateProtocolVersion(clientVersion: unknown): number {
  if (typeof clientVersion === "number" && Number.isInteger(clientVersion) && clientVersion > 0) {
    return Math.min(clientVersion, ACP_PROTOCOL_VERSION);
  }
  return ACP_PROTOCOL_VERSION;
}

export function buildInitializeResult(): {
  protocolVersion: number;
  agentCapabilities: object;
  agentInfo: object;
  authMethods: unknown[];
} {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
      _meta: {
        "commoncosmo.com": {
          cleetus: {
            evidenceBundles: 1,
            findingRawOutput: 1,
            clientJobs: 1,
            securityStateReattachment: 1,
            sarifNormalization: 1,
            cycloneDxNormalization: 1,
            osvNormalization: 1,
            zapPassiveNormalization: 1,
          },
        },
      },
    },
    agentInfo: { name: "cleetus", title: "cleetus", version: "0" },
    authMethods: [],
  };
}

export function parseClientCapabilities(params: unknown): ClientCapabilities {
  const c = (params as { clientCapabilities?: ClientCapabilities } | null)?.clientCapabilities;
  return c ?? {};
}

export function clientSupportsFsRead(c: ClientCapabilities): boolean {
  return c.fs?.readTextFile === true;
}
export function clientSupportsFsWrite(c: ClientCapabilities): boolean {
  return c.fs?.writeTextFile === true;
}
export function clientSupportsTerminal(c: ClientCapabilities): boolean {
  return c.terminal === true;
}

/** Parse the namespaced, opt-in client-managed job extension. Invalid or oversized capability
 *  declarations disable the surface instead of exposing tools with an ambiguous contract. */
export function clientJobCapabilities(c: ClientCapabilities): ClientJobCapabilities | null {
  const domain = objectValue(c._meta?.["commoncosmo.com"]);
  const cleetus = objectValue(domain?.cleetus);
  const jobs = objectValue(cleetus?.jobs);
  if (jobs?.version !== 1 || !Array.isArray(jobs.kinds)) return null;
  if (jobs.kinds.length === 0 || jobs.kinds.length > 64) return null;

  const kinds: string[] = [];
  const seen = new Set<string>();
  for (const value of jobs.kinds) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ||
      seen.has(value)
    ) {
      return null;
    }
    seen.add(value);
    kinds.push(value);
  }

  const advertisedMax = jobs.maxArtifactReadBytes;
  const maxArtifactReadBytes =
    typeof advertisedMax === "number" && Number.isInteger(advertisedMax) && advertisedMax >= 1_024
      ? Math.min(advertisedMax, MAX_JOB_ARTIFACT_READ_BYTES)
      : DEFAULT_JOB_ARTIFACT_READ_BYTES;
  return { version: 1, kinds, maxArtifactReadBytes };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
