import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowGrantStore } from "../../src/workflows/grants";
import { normalizeWorkflowPermissions } from "../../src/workflows/permissions";

const permissions = normalizeWorkflowPermissions({
  network: [{ host: "api.example.com", methods: ["GET"] }],
});

describe("WorkflowGrantStore", () => {
  test("binds grants to exact execution hash and capability set", () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-grants-"));
    const store = new WorkflowGrantStore(join(dir, "project.yaml"), join(dir, "global.yaml"));
    store.persist("project", {
      workflow: "weather",
      executionHash: "hash-one",
      permissions,
      decision: "allow",
    });
    expect(
      store.lookup({ workflow: "weather", executionHash: "hash-one", permissions }).decision,
    ).toBe("allow");
    expect(
      store.lookup({ workflow: "weather", executionHash: "hash-two", permissions }).decision,
    ).toBe("missing");
    expect(
      store.lookup({
        workflow: "weather",
        executionHash: "hash-one",
        permissions: normalizeWorkflowPermissions({
          network: [{ host: "api.example.com", methods: ["POST"] }],
        }),
      }).decision,
    ).toBe("missing");
    expect(readFileSync(join(dir, "project.yaml"), "utf8")).toContain("executionHash: hash-one");
  });

  test("project decisions take precedence and explicit deny is preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-grants-"));
    const store = new WorkflowGrantStore(join(dir, "project.yaml"), join(dir, "global.yaml"));
    store.persist("global", {
      workflow: "weather",
      executionHash: "hash",
      permissions,
      decision: "allow",
    });
    store.persist("project", {
      workflow: "weather",
      executionHash: "hash",
      permissions,
      decision: "deny",
    });
    expect(store.lookup({ workflow: "weather", executionHash: "hash", permissions })).toMatchObject(
      {
        decision: "deny",
        scope: "project",
      },
    );
  });
});
