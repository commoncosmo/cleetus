import { describe, expect, test } from "bun:test";
import { parseAcpOptions } from "../../src/acp/cli";
import { pinnedOrParamCwd } from "../../src/acp/session-methods";

describe("parseAcpOptions launch flags", () => {
  test("parses --global", () => {
    const o = parseAcpOptions(["node", "cleetus", "acp", "--global"]);
    expect(o.global).toBe(true);
    expect(o.scratch).toBeUndefined();
  });
  test("parses --scratch", () => {
    const o = parseAcpOptions(["node", "cleetus", "acp", "--scratch"]);
    expect(o.scratch).toBe(true);
  });
  test("neither flag → both undefined", () => {
    const o = parseAcpOptions(["node", "cleetus", "acp"]);
    expect(o.global).toBeUndefined();
    expect(o.scratch).toBeUndefined();
  });
});

describe("pinnedOrParamCwd", () => {
  test("pinned wins over the client-provided cwd", () => {
    expect(pinnedOrParamCwd("/pin", "/client/cwd", "/fallback")).toBe("/pin");
  });
  test("falls back to the param cwd when not pinned", () => {
    expect(pinnedOrParamCwd(undefined, "/client/cwd", "/fallback")).toBe("/client/cwd");
  });
  test("falls back to the fallback when neither is set", () => {
    expect(pinnedOrParamCwd(undefined, undefined, "/fallback")).toBe("/fallback");
  });
});
