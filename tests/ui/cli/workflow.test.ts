import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { parseWorkflowCliInputs, runWorkflowCli } from "../../../src/ui/cli/workflow";
import { renderWorkflowSkillAdapter } from "../../../src/workflows/adapter";
import { WorkflowDraftStore } from "../../../src/workflows/creator/draft-store";
import { WorkflowRunStore } from "../../../src/workflows/journal";
import { loadWorkflowPackage } from "../../../src/workflows/package";
import { resolved } from "../../../src/workflows/provenance";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-cli-"));
  const project = join(root, "project");
  const config = join(root, "config");
  const dir = join(project, ".cleetus", "workflows", "select-one");
  mkdirSync(dir, { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(dir, "workflow.yaml"),
    `
schema_version: 1
name: select-one
revision: 1
description: Select one value
inputs:
  type: object
  required: [value]
  properties:
    value: { type: string, minLength: 1 }
permissions: {}
execution: { timeout: 10s }
steps:
  - id: select
    uses: data.select@1
    with:
      value: $inputs
      pointer: /value
outputs:
  result:
    value: $steps.select.output
    schema: {}
presentation: { output: result }
`,
  );
  return { project, config };
}

async function invoke(
  args: string[],
  prepare?: (paths: { project: string; config: string }) => void,
) {
  const { project, config } = fixture();
  prepare?.({ project, config });
  let stdout = "";
  let stderr = "";
  const code = await runWorkflowCli(
    ["bun", "cleetus", "workflow", "--project-dir", project, "--config-dir", config, ...args],
    project,
    {
      write: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    },
  );
  return { code, stdout, stderr };
}

async function invokeAt(
  paths: { project: string; config: string },
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runWorkflowCli(
    [
      "bun",
      "cleetus",
      "workflow",
      "--project-dir",
      paths.project,
      "--config-dir",
      paths.config,
      ...args,
    ],
    paths.project,
    {
      write: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    },
  );
  return { code, stdout, stderr };
}

describe("cleetus workflow", () => {
  test("initializes valid project and global workflow skeletons without overwriting", async () => {
    let projectRoot = "";
    const project = await invoke(
      ["init", "manual-report", "--description", "Build a manual report"],
      (paths) => {
        projectRoot = paths.project;
      },
    );
    expect(project).toMatchObject({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining("Created project workflow skeleton 'manual-report'"),
    });
    const projectDir = join(projectRoot, ".cleetus", "workflows", "manual-report");
    expect(loadWorkflowPackage(projectDir, "project").manifest.description).toBe(
      "Build a manual report",
    );
    expect(existsSync(join(projectDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectDir, "tests", "skeleton.yaml"))).toBe(true);

    let globalRoot = "";
    const global = await invoke(["--json", "init", "shared-report", "--global"], (paths) => {
      globalRoot = paths.config;
    });
    expect(global.code).toBe(0);
    expect(JSON.parse(global.stdout)).toMatchObject({
      name: "shared-report",
      scope: "global",
      dir: join(globalRoot, "workflows", "shared-report"),
    });

    const duplicate = await invoke(["init", "select-one"]);
    expect(duplicate).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already exists"),
    });
  });

  test("lists, validates, and dry-runs without provider or sandbox startup", async () => {
    expect(await invoke(["list"])).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("select-one"),
    });
    expect(await invoke(["validate", "select-one"])).toMatchObject({ code: 0, stdout: "valid\n" });
    const dry = await invoke(["dry-run", "select-one", "--input", "value=chosen"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("data.select@1");
  });

  test("runs hand-authored JSON test cases as well as YAML", async () => {
    const result = await invoke(["test", "select-one"], ({ project }) => {
      const testsDir = join(project, ".cleetus", "workflows", "select-one", "tests");
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, "success.json"),
        JSON.stringify({
          schema_version: 1,
          name: "selects JSON input",
          mode: "mock",
          inputs: { value: "chosen" },
          mocks: {},
          expect: {
            status: "succeeded",
            outputs: { result: "chosen" },
            attempts: { select: 1 },
          },
        }),
      );
    });

    expect(result).toMatchObject({
      code: 0,
      stdout: "✓ selects JSON input\n",
      stderr: "",
    });
  });

  test("manages an isolated manual revision through review and publish without running it", async () => {
    const paths = fixture();
    const revised = await invokeAt(paths, ["revise", "select-one"]);
    const draftDir = join(
      paths.project,
      ".cleetus",
      "workflows",
      ".manual-drafts",
      "select-one",
      "package",
      "select-one",
    );
    expect(revised).toMatchObject({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining(`Draft: ${draftDir}`),
    });
    const activePath = join(paths.project, ".cleetus", "workflows", "select-one", "workflow.yaml");
    expect(parse(readFileSync(activePath, "utf8")).description).toBe("Select one value");

    const draftPath = join(draftDir, "workflow.yaml");
    const manifest = parse(readFileSync(draftPath, "utf8")) as Record<string, unknown>;
    manifest.description = "Select one revised value";
    writeFileSync(draftPath, stringify(manifest));
    writeFileSync(join(draftDir, "SKILL.md"), "This hand edit must be replaced.\n");

    const review = await invokeAt(paths, ["review", "select-one"]);
    expect(review.stdout).toContain("metadata: description");
    expect(review.stdout).toContain("Tests: none");
    expect(review).toMatchObject({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining("Base status: current"),
    });

    const published = await invokeAt(paths, ["publish", "select-one"]);
    expect(published.stdout).toContain("The workflow was not run.");
    expect(published).toMatchObject({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining("revision 2"),
    });
    const active = loadWorkflowPackage(
      join(paths.project, ".cleetus", "workflows", "select-one"),
      "project",
    );
    expect(active.manifest).toMatchObject({
      revision: 2,
      description: "Select one revised value",
    });
    expect(readFileSync(join(active.dir, "SKILL.md"), "utf8")).toBe(
      renderWorkflowSkillAdapter(active.manifest),
    );
    expect(
      existsSync(join(paths.project, ".cleetus", "workflows", ".revisions", "select-one")),
    ).toBe(true);
    expect(
      existsSync(join(paths.project, ".cleetus", "workflows", ".manual-drafts", "select-one")),
    ).toBe(false);
    expect(existsSync(join(paths.project, ".cleetus", "workflows.db"))).toBe(false);
  });

  test("blocks stale or failing manual revisions and supports discard", async () => {
    const stale = fixture();
    await invokeAt(stale, ["revise", "select-one"]);
    const staleDraftPath = join(
      stale.project,
      ".cleetus",
      "workflows",
      ".manual-drafts",
      "select-one",
      "package",
      "select-one",
      "workflow.yaml",
    );
    const staleDraft = parse(readFileSync(staleDraftPath, "utf8")) as Record<string, unknown>;
    staleDraft.description = "Draft description";
    writeFileSync(staleDraftPath, stringify(staleDraft));
    const activePath = join(stale.project, ".cleetus", "workflows", "select-one", "workflow.yaml");
    const active = parse(readFileSync(activePath, "utf8")) as Record<string, unknown>;
    active.description = "Concurrent active edit";
    writeFileSync(activePath, stringify(active));

    const staleReview = await invokeAt(stale, ["review", "select-one"]);
    expect(staleReview.code).toBe(3);
    expect(staleReview.stdout).toContain("Base status: stale");
    expect(staleReview.stdout).toContain(
      "cleetus workflow discard select-one removes only the isolated draft",
    );
    const stalePublish = await invokeAt(stale, ["publish", "select-one"]);
    expect(stalePublish.code).toBe(1);
    expect(stalePublish.stderr).toContain("changed outside this draft");
    expect(stalePublish.stderr).toContain(
      "cleetus workflow discard select-one removes only the isolated draft",
    );
    expect(stalePublish.stderr).toContain("it does not undo changes to the active package");
    expect(stalePublish.stderr).toContain(
      "restore the active package from source control or another known-good copy",
    );
    expect(
      loadWorkflowPackage(join(stale.project, ".cleetus", "workflows", "select-one"), "project")
        .manifest.revision,
    ).toBe(1);
    expect(await invokeAt(stale, ["discard", "select-one"])).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("active workflow was not changed"),
    });

    const failing = fixture();
    const activeTests = join(failing.project, ".cleetus", "workflows", "select-one", "tests");
    mkdirSync(activeTests, { recursive: true });
    writeFileSync(
      join(activeTests, "select.yaml"),
      stringify({
        schema_version: 1,
        name: "selects input",
        mode: "mock",
        inputs: { value: "chosen" },
        mocks: {},
        expect: {
          status: "succeeded",
          outputs: { result: "chosen" },
          attempts: { select: 1 },
        },
      }),
    );
    await invokeAt(failing, ["revise", "select-one"]);
    const failingRoot = join(
      failing.project,
      ".cleetus",
      "workflows",
      ".manual-drafts",
      "select-one",
      "package",
      "select-one",
    );
    const failingManifestPath = join(failingRoot, "workflow.yaml");
    const failingManifest = parse(readFileSync(failingManifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    failingManifest.description = "A failing revision";
    writeFileSync(failingManifestPath, stringify(failingManifest));
    const failingTest = parse(readFileSync(join(failingRoot, "tests", "select.yaml"), "utf8")) as {
      expect: { outputs: { result: string } };
    };
    failingTest.expect.outputs.result = "wrong";
    writeFileSync(join(failingRoot, "tests", "select.yaml"), stringify(failingTest));

    expect(await invokeAt(failing, ["review", "select-one"])).toMatchObject({
      code: 3,
      stdout: expect.stringContaining("Tests: 0/1 passed"),
    });
    expect(await invokeAt(failing, ["publish", "select-one"])).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("tests failed"),
    });

    const invalid = fixture();
    await invokeAt(invalid, ["revise", "select-one"]);
    const invalidPath = join(
      invalid.project,
      ".cleetus",
      "workflows",
      ".manual-drafts",
      "select-one",
      "package",
      "select-one",
      "workflow.yaml",
    );
    const invalidManifest = parse(readFileSync(invalidPath, "utf8")) as {
      description: string;
      steps: Array<{ uses: string }>;
    };
    invalidManifest.description = "Invalid revision";
    invalidManifest.steps[0]!.uses = "unknown.action@1";
    writeFileSync(invalidPath, stringify(invalidManifest));
    expect(await invokeAt(invalid, ["review", "select-one"])).toMatchObject({
      code: 3,
      stdout: expect.stringContaining("Validation: failed"),
    });
    expect(await invokeAt(invalid, ["publish", "select-one"])).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("manual workflow draft is invalid"),
    });
  });

  test("revises and publishes global workflows explicitly", async () => {
    const paths = fixture();
    const globalRoot = join(paths.config, "workflows");
    const globalDir = join(globalRoot, "shared");
    mkdirSync(globalDir, { recursive: true });
    const projectManifest = parse(
      readFileSync(
        join(paths.project, ".cleetus", "workflows", "select-one", "workflow.yaml"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    projectManifest.name = "shared";
    projectManifest.description = "Shared global workflow";
    writeFileSync(join(globalDir, "workflow.yaml"), stringify(projectManifest));

    expect(await invokeAt(paths, ["revise", "shared", "--global"])).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Base: global revision 1"),
    });
    const draftManifestPath = join(
      globalRoot,
      ".manual-drafts",
      "shared",
      "package",
      "shared",
      "workflow.yaml",
    );
    const draftManifest = parse(readFileSync(draftManifestPath, "utf8")) as Record<string, unknown>;
    draftManifest.description = "Revised shared workflow";
    writeFileSync(draftManifestPath, stringify(draftManifest));
    expect(await invokeAt(paths, ["review", "shared", "--global"])).toMatchObject({ code: 0 });
    expect(await invokeAt(paths, ["publish", "shared", "--global"])).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Published global workflow"),
    });
    expect(loadWorkflowPackage(globalDir, "global").manifest).toMatchObject({
      revision: 2,
      description: "Revised shared workflow",
    });
  });

  test("dry-run parses and validates the same typed inputs as run", async () => {
    const supplied = await invoke(["--json", "dry-run", "select-one", "--input", "value=chosen"]);
    expect(supplied.code).toBe(0);
    expect(JSON.parse(supplied.stdout).preflight.unresolved).toEqual([]);

    const missing = await invoke(["dry-run", "select-one"]);
    expect(missing).toMatchObject({
      code: 3,
      stderr: expect.stringContaining("required"),
    });
  });

  test("parses typed repeated inputs and rejects duplicates or malformed JSON-like values", () => {
    expect(parseWorkflowCliInputs(["count=3", "enabled=true", "name=Sam"])).toEqual({
      count: 3,
      enabled: true,
      name: "Sam",
    });
    expect(() => parseWorkflowCliInputs(["name=one", "name=two"])).toThrow("duplicate");
    expect(() => parseWorkflowCliInputs(["value={bad"])).toThrow("not valid JSON");
  });

  test("blocks a persisted replacement before parsing inputs or opening the run journal", async () => {
    let projectPath = "";
    const result = await invoke(["run", "select-one", "--input", "value={bad"], ({ project }) => {
      projectPath = project;
      const workflowsRoot = join(project, ".cleetus", "workflows");
      const pkg = loadWorkflowPackage(join(workflowsRoot, "select-one"), "project");
      const store = new WorkflowDraftStore(workflowsRoot);
      const draft = store.create({
        scope: "project",
        name: "select-one",
        sessionId: "another-session",
        targetRevision: 2,
      });
      draft.phase = "draft";
      draft.output = {
        response: "Ready",
        phase: "draft",
        manifest: { ...pkg.manifest, revision: 2 },
        assumptions: [],
        unresolvedQuestions: [],
      };
      store.save(draft);
    });

    expect(result.stderr.includes("ambiguous JSON-like input")).toBe(false);
    expect(result).toMatchObject({
      code: 4,
      stderr: expect.stringContaining("valid replacement revision 2"),
    });
    expect(existsSync(join(projectPath, ".cleetus", "workflows.db"))).toBe(false);
  });

  test("inspects a recorded run with step and model-attempt details", async () => {
    const result = await invoke(["history", "select-one", "run-detail"], ({ project }) => {
      const store = new WorkflowRunStore(join(project, ".cleetus", "workflows.db"));
      store.createRun({
        id: "run-detail",
        workflowName: "select-one",
        revision: 1,
        packageHash: "package",
        executionHash: "execution",
        workspace: project,
        inputs: resolved({ value: "chosen" }),
        steps: [
          {
            id: "recommend",
            ordinal: 0,
            uses: "llm.generate@1",
            effect: "read-only",
          },
        ],
      });
      store.setRunStatus("run-detail", "running");
      const attempt = store.startStep("run-detail", "recommend");
      store.succeedStep(
        "run-detail",
        "recommend",
        attempt,
        resolved({ recommendation: "Add revise" }),
      );
      store.recordModelAttempt({
        runId: "run-detail",
        stepId: "recommend",
        attempt: 1,
        provider: "local",
        requestedModel: "model-a",
        finishReason: "stop",
        inputTokens: 100,
        outputTokens: 20,
        promptHash: "hash",
        constrained: true,
        startedAt: 1,
        endedAt: 2,
      });
      store.setRunStatus("run-detail", "succeeded", {
        outputs: resolved({ result: "Add revise" }),
      });
      store.close();
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Run: run-detail");
    expect(result.stdout).toContain("recommend (llm.generate@1) — succeeded");
    expect(result.stdout).toContain("local/model-a");
    expect(result.stdout).toContain("tokens 100→20");
  });
});
