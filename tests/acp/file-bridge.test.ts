import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpFileBridge, DirectFileBridge } from "../../src/acp/file-bridge";

describe("DirectFileBridge", () => {
  it("reads and writes the real disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-fb-"));
    const p = join(dir, "a.txt");
    const b = new DirectFileBridge();
    await b.writeTextFile(p, "hello");
    expect(await b.readTextFile(p)).toBe("hello");
  });
});

describe("AcpFileBridge", () => {
  it("reads via the client's fs/read_text_file", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const request = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { content: "from-client" };
    };
    const b = new AcpFileBridge(request, "s1");
    expect(await b.readTextFile("/abs/a.txt")).toBe("from-client");
    expect(calls[0]).toEqual({
      method: "fs/read_text_file",
      params: { sessionId: "s1", path: "/abs/a.txt" },
    });
  });

  it("writes via the client's fs/write_text_file", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const request = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return null;
    };
    const b = new AcpFileBridge(request, "s1");
    await b.writeTextFile("/abs/a.txt", "data");
    expect(calls[0]).toEqual({
      method: "fs/write_text_file",
      params: { sessionId: "s1", path: "/abs/a.txt", content: "data" },
    });
  });
});
