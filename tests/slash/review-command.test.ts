import { expect, test } from "bun:test";
import type { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";

const baseDeps = {
  providers: {} as ProviderRegistry,
  getActive: () => ({ provider: "p", model: "m" }),
  setActive: () => {},
  getPermissions: () => ({}) as never,
};

test("/review is registered only when runReview dep is present", () => {
  const withDep = buildCommandRegistry({
    ...baseDeps,
    runReview: async () => {},
  });
  expect(withDep.get("review")).toBeDefined();

  const withoutDep = buildCommandRegistry({ ...baseDeps });
  expect(withoutDep.get("review")).toBeUndefined();
});

test("/review forwards args and print to runReview", async () => {
  let got = "";
  const reg = buildCommandRegistry({
    ...baseDeps,
    runReview: async (a) => {
      got = a;
    },
  });
  const review = reg.get("review")!;
  expect(review).toBeDefined();
  await review.run("HEAD~2", { cwd: "/x", print: () => {} });
  expect(got).toBe("HEAD~2");
});
