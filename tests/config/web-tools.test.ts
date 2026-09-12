import { describe, expect, it } from "bun:test";
import { DEFAULT_WEB_MAX_BYTES, resolveWebTools } from "../../src/config/web-tools";

describe("resolveWebTools", () => {
  it("applies defaults when nothing is set", () => {
    expect(resolveWebTools(undefined, undefined)).toEqual({
      enabled: true,
      allowLocalhost: false,
      maxBytes: 50000,
      search: { provider: "duckduckgo" },
    });
  });
  it("merges project over global", () => {
    const r = resolveWebTools(
      { enabled: false, allow_localhost: true, max_bytes: 1000 },
      { enabled: true, search: { provider: "brave", brave_api_key: "K" } },
    );
    expect(r.enabled).toBe(true);
    expect(r.allowLocalhost).toBe(true); // from global, project didn't set it
    expect(r.maxBytes).toBe(1000); // from global
    expect(r.search).toEqual({ provider: "brave", braveApiKey: "K" });
  });
  it("omits braveApiKey when unset", () => {
    const r = resolveWebTools(undefined, { search: { provider: "brave" } });
    expect(r.search).toEqual({ provider: "brave" });
  });
  it("DEFAULT_WEB_MAX_BYTES is 50000", () => {
    expect(DEFAULT_WEB_MAX_BYTES).toBe(50000);
  });
});
