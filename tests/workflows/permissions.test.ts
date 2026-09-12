import { describe, expect, test } from "bun:test";
import {
  formatWorkflowPreflight,
  normalizeWorkflowPermissions,
  workflowPermissionsContain,
} from "../../src/workflows/permissions";

const allowed = normalizeWorkflowPermissions(
  {
    network: [{ host: "API.Example.COM.", methods: ["post", "GET", "GET"] }],
    commands: [{ program: "bun", argsPrefix: ["run"] }],
    filesystem: { read: ["$project/data/**"], write: ["$project/out/report.json"] },
    model: true,
  },
  "/work",
);

describe("workflow permissions", () => {
  test("normalizes and performs exact capability subset checks", () => {
    expect(allowed.network).toEqual([{ host: "api.example.com", methods: ["GET", "POST"] }]);
    expect(
      workflowPermissionsContain(allowed, {
        network: [{ host: "api.example.com", methods: ["GET"] }],
        commands: [{ program: "bun", argsPrefix: ["run", "script.ts"] }],
        filesystem: { read: ["/work/data/input.json"], write: ["/work/out/report.json"] },
      }),
    ).toBe(true);
    expect(
      workflowPermissionsContain(allowed, {
        network: [{ host: "other.example.com", methods: ["GET"] }],
      }),
    ).toBe(false);
    expect(
      workflowPermissionsContain(allowed, {
        commands: [{ program: "bun", argsPrefix: ["test"] }],
      }),
    ).toBe(false);
    expect(
      workflowPermissionsContain(allowed, {
        filesystem: { read: ["/work/private"], write: [] },
      }),
    ).toBe(false);
  });

  test("produces a stable consolidated preflight without secret values", () => {
    expect(
      formatWorkflowPreflight({
        permissions: allowed,
        maximumAttempts: 3,
        maximumModelCalls: 1,
        effect: "side-effecting",
        requiredSecrets: ["api_key"],
        unresolved: ["steps.fetch.url"],
      }),
    ).toContain("Secrets: api_key");
    expect(
      formatWorkflowPreflight({
        permissions: allowed,
        maximumAttempts: 3,
        maximumModelCalls: 1,
        effect: "side-effecting",
        requiredSecrets: ["api_key"],
        unresolved: ["steps.fetch.url"],
      }),
    ).not.toContain("secret-value");
  });
});
