import { describe, expect, it } from "bun:test";
import { selectProvider } from "../../../src/web/search/factory";

describe("selectProvider", () => {
  it("uses Brave when a config key is present", () => {
    const r = selectProvider({ provider: "duckduckgo", braveApiKey: "K" }, {});
    expect("provider" in r && r.provider.name).toBe("brave");
  });
  it("uses Brave when the env key is present", () => {
    const r = selectProvider({ provider: "duckduckgo" }, { BRAVE_SEARCH_API_KEY: "K" });
    expect("provider" in r && r.provider.name).toBe("brave");
  });
  it("falls back to DuckDuckGo with no key", () => {
    const r = selectProvider({ provider: "duckduckgo" }, {});
    expect("provider" in r && r.provider.name).toBe("duckduckgo");
  });
  it("errors when brave is explicitly chosen but no key exists", () => {
    const r = selectProvider({ provider: "brave" }, {});
    expect("error" in r && r.error).toContain("BRAVE_SEARCH_API_KEY");
  });
});
