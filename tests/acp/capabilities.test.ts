import { describe, expect, it } from "bun:test";
import {
  ACP_PROTOCOL_VERSION,
  buildInitializeResult,
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
});
