export const ACP_PROTOCOL_VERSION = 1;

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

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
