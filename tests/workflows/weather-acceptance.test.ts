import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "../../src/providers/types";
import { activateWorkflowDraft } from "../../src/workflows/creator/activate";
import { WorkflowCreatorController } from "../../src/workflows/creator/controller";
import { WorkflowDraftStore } from "../../src/workflows/creator/draft-store";
import type { WorkflowEvent } from "../../src/workflows/events";
import { WorkflowRunStore } from "../../src/workflows/journal";
import { WorkflowModelCallService } from "../../src/workflows/model-call";
import { loadWorkflowPackage } from "../../src/workflows/package";
import { parseWorkflowManifest } from "../../src/workflows/parse";
import { WorkflowRegistry } from "../../src/workflows/registry";
import { WorkflowSchemaService } from "../../src/workflows/schema";
import { WorkflowService } from "../../src/workflows/service";
import { createBuiltinWorkflowStepRegistry } from "../../src/workflows/steps";

describe("weather workflow acceptance", () => {
  test("creates, activates, dry-runs, executes, journals, and offline-tests the package", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-weather-"));
    const workflowsRoot = join(root, ".cleetus", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    const fixtureDir = fileURLToPath(
      new URL("../fixtures/workflows/weather-brief", import.meta.url),
    );
    const requests: string[] = [];
    const provider: Provider = {
      async *chat() {
        yield {
          type: "text-delta",
          text: JSON.stringify(["Cold this morning", "Milder this afternoon", "Dry all day"]),
        };
        yield { type: "finish", reason: "stop", usage: { input: 20, output: 12 } };
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const schemas = new WorkflowSchemaService();
    const calls = new WorkflowModelCallService(() => provider);
    const stepRegistry = (packageDir: string, store?: WorkflowRunStore) =>
      createBuiltinWorkflowStepRegistry({
        schemas,
        packageDir,
        journal: store,
        defaultModel: { provider: "fake", model: "fake-model" },
        modelCalls: calls,
        transport: async (url) => {
          requests.push(url.toString());
          return {
            status: 200,
            headers: { get: () => "application/json" },
            text: async () => '{"hourly":{"temperature_2m":[32,40,45]}}',
            dispose() {},
          };
        },
        sandbox: {
          async exec() {
            throw new Error("command sandbox must not be called");
          },
          async dispose() {},
          writeRoot: () => null,
        },
      });
    const manifest = parseWorkflowManifest(readFileSync(join(fixtureDir, "workflow.yaml"), "utf8"));
    const creator = new WorkflowCreatorController(
      new WorkflowDraftStore(workflowsRoot),
      {
        async respond() {
          return {
            response: "The weather workflow is ready for review.",
            phase: "draft",
            manifest,
            resources: [
              {
                path: "tests/success.yaml",
                content: readFileSync(join(fixtureDir, "tests", "success.yaml"), "utf8"),
              },
            ],
            assumptions: [],
            unresolvedQuestions: [],
          };
        },
      },
      "Create a strict workflow draft.",
      (packageDir) => stepRegistry(packageDir),
    );
    const draft = creator.start({ name: "weather-brief" });
    draft.creationProtocol = "legacy-full-package";
    draft.requirementMessages = undefined;
    new WorkflowDraftStore(workflowsRoot).save(draft);
    const reviewed = await creator.respond(draft.id, "Fetch and summarize Wilmette weather.");
    expect(reviewed.diagnostics).toEqual([]);
    expect(requests).toEqual([]);
    activateWorkflowDraft({
      draftPackageDir: creator.packageDir(reviewed),
      activeRoot: workflowsRoot,
      scope: "project",
      steps: (packageDir) => stepRegistry(packageDir),
    });
    expect(requests).toEqual([]);

    const runDb = join(root, ".cleetus", "workflows.db");
    const lifecycle: WorkflowEvent[] = [];
    const service = new WorkflowService({
      registry: new WorkflowRegistry({
        projectDir: root,
        globalDir: join(root, "global"),
      }),
      workspace: root,
      openStore: () => new WorkflowRunStore(runDb),
      authorize: async () => "allow_once",
      events: {
        emit(event) {
          lifecycle.push(event);
        },
      },
      stepRegistry(pkg, store) {
        return stepRegistry(pkg.dir, store);
      },
    });
    expect(service.dryRun("weather-brief").steps).toHaveLength(3);
    expect(requests).toEqual([]);
    const result = await service.run({ name: "weather-brief", inputs: {} });
    expect(result.status).toBe("succeeded");
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run_status",
          workflow: "weather-brief",
          status: "preparing",
        }),
        expect.objectContaining({
          type: "run_status",
          workflow: "weather-brief",
          status: "awaiting_permission",
        }),
        expect.objectContaining({
          type: "step_status",
          workflow: "weather-brief",
          ordinal: 1,
          totalSteps: 3,
          status: "running",
        }),
        expect.objectContaining({
          type: "run_status",
          workflow: "weather-brief",
          status: "succeeded",
        }),
      ]),
    );
    expect(result.outputs?.brief).toBe(
      "- Cold this morning\n- Milder this afternoon\n- Dry all day\n",
    );
    expect(requests).toEqual([
      "https://api.open-meteo.com/v1/forecast?hourly=temperature_2m&latitude=42.07225&longitude=-87.72284&temperature_unit=fahrenheit",
    ]);
    expect(service.history({ workflowName: "weather-brief" })).toHaveLength(1);
    expect((await service.test("weather-brief")).every((item) => item.passed)).toBe(true);
    expect(
      loadWorkflowPackage(join(workflowsRoot, "weather-brief"), "project").manifest.revision,
    ).toBe(1);
  });
});
