import { expect, test } from "bun:test";
import type { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

const baseDeps = {
  providers: {} as ProviderRegistry,
  getActive: () => ({ provider: "p", model: "m" }),
  setActive: () => {},
  getPermissions: () => ({}) as never,
};

test("/insights is hidden when runInsights dep is absent", () => {
  const reg = buildCommandRegistry({ ...baseDeps });
  expect(reg.get("insights")).toBeUndefined();
});

test("/insights invokes runInsights with args and a print sink", async () => {
  let received = "";
  let out = "";
  const reg = buildCommandRegistry({
    ...baseDeps,
    runInsights: async (args, print) => {
      received = args;
      print("INSIGHTS OUTPUT");
    },
  });
  const cmd = reg.get("insights");
  expect(cmd).toBeDefined();
  await cmd!.run("since 7d", {
    cwd: "/tmp",
    print: (s) => {
      out += s;
    },
  });
  expect(received).toBe("since 7d");
  expect(out).toBe("INSIGHTS OUTPUT");
});

test("/analyze resolves to the insights command via alias", () => {
  const reg = buildCommandRegistry({ ...baseDeps, runInsights: async () => {} });
  expect(reg.get("analyze")).toBe(reg.get("insights"));
});
