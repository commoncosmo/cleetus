import { describe, expect, it } from "bun:test";
import { DEFAULT_REPO_MAP_TOKEN_BUDGET, resolveRepoMap } from "../../src/config/repo-map";

describe("resolveRepoMap", () => {
  it("defaults to enabled with the default budget when nothing is set", () => {
    expect(resolveRepoMap(undefined, undefined)).toEqual({
      enabled: true,
      tokenBudget: DEFAULT_REPO_MAP_TOKEN_BUDGET,
    });
  });

  it("lets project override global (project-over-global)", () => {
    const global = { enabled: true, token_budget: 1500 };
    const project = { enabled: false, token_budget: 800 };
    expect(resolveRepoMap(global, project)).toEqual({ enabled: false, tokenBudget: 800 });
  });

  it("falls back to global when project omits a field", () => {
    expect(resolveRepoMap({ token_budget: 2000 }, {})).toEqual({
      enabled: true,
      tokenBudget: 2000,
    });
  });
});
