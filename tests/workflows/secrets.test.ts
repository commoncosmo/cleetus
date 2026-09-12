import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRunStore } from "../../src/workflows/journal";
import { WorkflowModelCallService } from "../../src/workflows/model-call";
import { WorkflowRegistry } from "../../src/workflows/registry";
import { WorkflowSecretResolver } from "../../src/workflows/secrets";
import { WorkflowService } from "../../src/workflows/service";
import { createBuiltinWorkflowStepRegistry } from "../../src/workflows/steps";

const declarations = {
  api_key: {
    source: "env" as const,
    name: "WEATHER_API_KEY",
    expose_to_llm: ["summary"],
  },
  missing: { source: "env" as const, name: "MISSING_VALUE" },
};

describe("WorkflowSecretResolver", () => {
  test("checks availability and resolves sensitive values", () => {
    const resolver = new WorkflowSecretResolver(declarations, {
      WEATHER_API_KEY: "secret-value",
    });
    expect(resolver.availability()).toEqual({
      available: ["api_key"],
      missing: ["missing"],
    });
    const value = resolver.resolve("api_key");
    expect(value.value).toBe("secret-value");
    expect(value.provenance.sensitive).toBe(true);
    expect(JSON.stringify(value.provenance)).not.toContain("secret-value");
  });

  test("requires explicit secret exposure for each LLM step", () => {
    const resolver = new WorkflowSecretResolver(declarations, {
      WEATHER_API_KEY: "secret-value",
    });
    expect(() => resolver.assertLlmExposure("api_key", "summary")).not.toThrow();
    expect(() => resolver.assertLlmExposure("api_key", "other")).toThrow(
      "not approved for LLM step",
    );
    expect(() => resolver.resolve("missing")).toThrow("unavailable");
  });
});

function secretHeaderService(
  environment: Record<string, string | undefined>,
  observe: {
    authorized: boolean;
    authorizationHeader?: string;
  },
) {
  const root = mkdtempSync(join(tmpdir(), "workflow-secret-header-"));
  const packageDir = join(root, ".cleetus", "workflows", "github-account");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "workflow.yaml"),
    `
schema_version: 1
name: github-account
revision: 1
description: Fetch the authenticated GitHub account
inputs:
  type: object
  properties: {}
  additionalProperties: false
secrets:
  github_token:
    source: env
    name: CLEETUS_WORKFLOW_GITHUB_TOKEN
    expose_to_llm: []
permissions:
  network:
    - host: api.github.com
      methods: [GET]
execution:
  timeout: 1m
steps:
  - id: fetch
    uses: http.request@1
    with:
      url: https://api.github.com/user
      method: GET
      headers:
        Authorization: Bearer \${secrets.github_token}
      response: json
outputs:
  account:
    value: $steps.fetch.output.body
    schema: { type: object }
presentation: { output: account }
`,
  );
  return new WorkflowService({
    registry: new WorkflowRegistry({
      projectDir: root,
      globalDir: join(root, "global"),
    }),
    workspace: root,
    environment,
    openStore: () => new WorkflowRunStore(":memory:"),
    async authorize() {
      observe.authorized = true;
      return "allow_once";
    },
    stepRegistry(pkg, store) {
      return createBuiltinWorkflowStepRegistry({
        packageDir: pkg.dir,
        journal: store,
        modelCalls: new WorkflowModelCallService(() => {
          throw new Error("model provider must not be called");
        }),
        sandbox: {
          async exec() {
            throw new Error("command sandbox must not be called");
          },
          async dispose() {},
          writeRoot: () => null,
        },
        transport: async (_url, init) => {
          observe.authorizationHeader = init.headers?.authorization;
          return {
            status: 200,
            headers: {
              get(name: string) {
                return name.toLowerCase() === "content-type" ? "application/json" : null;
              },
            },
            async text() {
              return '{"login":"octocat"}';
            },
            dispose() {},
          };
        },
      });
    },
  });
}

describe("workflow service secret preflight", () => {
  test("reports an interpolated missing secret before authorization or execution", async () => {
    const observed = { authorized: false };
    const service = secretHeaderService({}, observed);

    expect(service.dryRun("github-account").preflight.requiredSecrets).toEqual(["github_token"]);
    await expect(service.run({ name: "github-account", inputs: {} })).rejects.toMatchObject({
      code: "missing_secret",
      message: "missing workflow secrets: github_token",
    });
    expect(observed).toEqual({ authorized: false });
  });

  test("injects an available interpolated secret into the HTTP header", async () => {
    const observed: { authorized: boolean; authorizationHeader?: string } = {
      authorized: false,
    };
    const service = secretHeaderService(
      { CLEETUS_WORKFLOW_GITHUB_TOKEN: "test-token-value" },
      observed,
    );

    const result = await service.run({ name: "github-account", inputs: {} });

    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({ account: { login: "octocat" } });
    expect(observed).toEqual({
      authorized: true,
      authorizationHeader: "Bearer test-token-value",
    });
  });
});
