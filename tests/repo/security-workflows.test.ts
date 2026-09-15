import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

function workflow(name: string) {
  return parse(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
}

test("release signing waits for same-commit quality and secrets checks", () => {
  const release = workflow("release");
  expect(release.jobs.quality.uses).toBe("./.github/workflows/ci.yml");
  expect(release.jobs.secrets.uses).toBe("./.github/workflows/secrets.yml");
  expect(release.jobs.verify.needs).toEqual(["quality", "secrets"]);
  expect(release.jobs["build-macos"].needs).toBe("verify");
  expect(release.jobs["build-linux"].needs).toBe("verify");
  expect(workflow("ci").on).toHaveProperty("workflow_call");
  expect(workflow("secrets").on).toHaveProperty("workflow_call");
  expect(
    workflow("ci").jobs.check.steps.some((step: { run?: string }) => step.run === "bun audit"),
  ).toBe(true);
});

test("read-only workflows do not persist checkout credentials", () => {
  for (const name of ["ci", "installer", "secrets", "dependencies", "release"]) {
    const config = workflow(name);
    expect(config.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(config.jobs) as {
      steps?: { uses?: string; with?: Record<string, unknown> }[];
    }[]) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@"))
          expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
  }
});
