import { describe, expect, it } from "bun:test";
import {
  ACP_PROTOCOL_VERSION,
  buildInitializeResult,
  clientJobCapabilities,
  clientSupportsFsRead,
  clientSupportsFsWrite,
  clientSupportsTerminal,
  negotiateProtocolVersion,
  parseClientCapabilities,
} from "../../src/acp/capabilities";

describe("ACP capabilities", () => {
  it("advertises loadSession and an empty authMethods list", () => {
    const r = buildInitializeResult();
    expect(r.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect((r.agentCapabilities as { loadSession?: boolean }).loadSession).toBe(true);
    expect(
      (
        r.agentCapabilities as {
          promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
        }
      ).promptCapabilities,
    ).toEqual({ image: true, audio: false, embeddedContext: true });
    expect(r.authMethods).toEqual([]);
    expect(
      (
        r.agentCapabilities as {
          _meta?: { "commoncosmo.com"?: { cleetus?: { clientJobs?: number } } };
        }
      )._meta?.["commoncosmo.com"]?.cleetus?.clientJobs,
    ).toBe(1);
    expect(
      (
        r.agentCapabilities as {
          _meta?: {
            "commoncosmo.com"?: { cleetus?: { securityStateReattachment?: number } };
          };
        }
      )._meta?.["commoncosmo.com"]?.cleetus?.securityStateReattachment,
    ).toBe(1);
    expect(
      (
        r.agentCapabilities as {
          _meta?: { "commoncosmo.com"?: { cleetus?: { sarifNormalization?: number } } };
        }
      )._meta?.["commoncosmo.com"]?.cleetus?.sarifNormalization,
    ).toBe(1);
    expect(
      (
        r.agentCapabilities as {
          _meta?: { "commoncosmo.com"?: { cleetus?: { cycloneDxNormalization?: number } } };
        }
      )._meta?.["commoncosmo.com"]?.cleetus?.cycloneDxNormalization,
    ).toBe(1);
    expect(
      (
        r.agentCapabilities as {
          _meta?: { "commoncosmo.com"?: { cleetus?: { osvNormalization?: number } } };
        }
      )._meta?.["commoncosmo.com"]?.cleetus?.osvNormalization,
    ).toBe(1);
    expect(
      (
        r.agentCapabilities as {
          _meta?: { "commoncosmo.com"?: { cleetus?: { zapPassiveNormalization?: number } } };
        }
      )._meta?.["commoncosmo.com"]?.cleetus?.zapPassiveNormalization,
    ).toBe(1);
  });

  it("negotiates to the lower shared version and falls back when client value is bad", () => {
    expect(negotiateProtocolVersion(1)).toBe(1);
    expect(negotiateProtocolVersion(99)).toBe(ACP_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(ACP_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion("x")).toBe(ACP_PROTOCOL_VERSION);
  });

  it("reads client fs/terminal capabilities", () => {
    const caps = parseClientCapabilities({
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: true },
    });
    expect(clientSupportsFsRead(caps)).toBe(true);
    expect(clientSupportsTerminal(caps)).toBe(true);
  });

  it("treats absent capabilities as unsupported", () => {
    const caps = parseClientCapabilities({});
    expect(clientSupportsFsRead(caps)).toBe(false);
    expect(clientSupportsTerminal(caps)).toBe(false);
  });

  it("detects fs write capability", () => {
    const withWrite = parseClientCapabilities({
      clientCapabilities: { fs: { writeTextFile: true } },
    });
    expect(clientSupportsFsWrite(withWrite)).toBe(true);

    const withoutWrite = parseClientCapabilities({
      clientCapabilities: { fs: { readTextFile: true } },
    });
    expect(clientSupportsFsWrite(withoutWrite)).toBe(false);
  });

  it("parses a bounded, namespaced client job capability", () => {
    const capabilities = clientJobCapabilities({
      _meta: {
        "commoncosmo.com": {
          cleetus: {
            jobs: {
              version: 1,
              kinds: ["sast.semgrep", "dast.zap"],
              maxArtifactReadBytes: 100_000,
            },
          },
        },
      },
    });
    expect(capabilities).toEqual({
      version: 1,
      kinds: ["sast.semgrep", "dast.zap"],
      maxArtifactReadBytes: 65_536,
    });
  });

  it("rejects malformed or duplicate client job kinds", () => {
    expect(
      clientJobCapabilities({
        _meta: {
          "commoncosmo.com": { cleetus: { jobs: { version: 1, kinds: ["sast", "sast"] } } },
        },
      }),
    ).toBeNull();
    expect(
      clientJobCapabilities({
        _meta: {
          "commoncosmo.com": { cleetus: { jobs: { version: 1, kinds: ["bad kind"] } } },
        },
      }),
    ).toBeNull();
  });
});
