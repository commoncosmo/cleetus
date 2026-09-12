import { describe, expect, it } from "bun:test";
import { AcpTransport } from "../../src/acp/transport";

function makeHarness() {
  const out: string[] = [];
  const t = new AcpTransport({ write: (line) => out.push(line) });
  return { t, out, parsed: () => out.map((l) => JSON.parse(l)) };
}

describe("AcpTransport", () => {
  it("dispatches an inbound request to its handler and writes one newline-delimited response", async () => {
    const { t, out, parsed } = makeHarness();
    t.onRequest("ping", async (params) => ({ echo: params }));
    await t.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { a: 1 } }));
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith("\n")).toBe(true);
    expect(out[0]!.slice(0, -1)).not.toContain("\n"); // no embedded newlines
    expect(parsed()[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { echo: { a: 1 } } });
  });

  it("returns a method-not-found error for an unknown method instead of throwing", async () => {
    const { t, parsed } = makeHarness();
    await t.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "nope" }));
    expect(parsed()[0]!.error.code).toBe(-32601);
  });

  it("returns a parse error for a malformed line without crashing, with id null", async () => {
    const { t, parsed } = makeHarness();
    await t.handleLine("{ this is not json");
    expect(parsed()[0]!.error.code).toBe(-32700);
    expect(parsed()[0]!.id).toBeNull();
  });

  it("correlates an outbound request id with the client's response", async () => {
    const { t, parsed } = makeHarness();
    const p = t.request("fs/read_text_file", { path: "/x" });
    const sentId = parsed()[0]!.id;
    await t.handleLine(JSON.stringify({ jsonrpc: "2.0", id: sentId, result: { content: "hi" } }));
    expect(await p).toEqual({ content: "hi" });
  });

  it("rejects an unanswered outbound request after the configured timeout", async () => {
    const out: string[] = [];
    const t = new AcpTransport({ write: (line) => out.push(line), requestTimeoutMs: 10 });
    const pending = t.request("session/request_permission", {});
    await expect(pending).rejects.toThrow(
      "ACP client request timed out after 10ms: session/request_permission",
    );
  });

  it("sends a notification with no id", () => {
    const { t, parsed } = makeHarness();
    t.notify("session/update", { sessionId: "s1" });
    expect(parsed()[0]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1" },
    });
  });
});
