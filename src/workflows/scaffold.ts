import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { renderWorkflowSkillAdapter } from "./adapter";
import { loadWorkflowPackage } from "./package";
import type { WorkflowManifest } from "./parse";
import { parseWorkflowTestCase } from "./test-case";
import type { WorkflowSource } from "./types";

const WORKFLOW_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface ScaffoldWorkflowInput {
  name: string;
  description?: string;
  root: string;
  scope: WorkflowSource;
}

export interface ScaffoldWorkflowResult {
  name: string;
  scope: WorkflowSource;
  dir: string;
  files: string[];
}

function titleFromName(name: string): string {
  return name
    .split("-")
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function skeletonManifest(name: string, description: string): WorkflowManifest {
  const output = `# ${titleFromName(name)}\n\nReplace this skeleton step with your workflow.\n`;
  return {
    schema_version: 1,
    name,
    revision: 1,
    description,
    inputs: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    permissions: {},
    execution: { timeout: "1m" },
    steps: [
      {
        id: "render",
        uses: "text.template@1",
        with: {
          template: output,
          data: {},
        },
      },
    ],
    outputs: {
      result: {
        value: "$steps.render.output",
        schema: { type: "string" },
      },
    },
    presentation: { output: "result" },
  };
}

function skeletonTest(output: string): string {
  return stringify({
    schema_version: 1,
    name: "skeleton renders",
    mode: "mock",
    inputs: {},
    mocks: {},
    expect: {
      status: "succeeded",
      outputs: { result: output },
      attempts: { render: 1 },
    },
  });
}

export function scaffoldWorkflowPackage(input: ScaffoldWorkflowInput): ScaffoldWorkflowResult {
  const name = input.name.trim();
  if (!WORKFLOW_NAME.test(name)) {
    throw new Error(
      "workflow name must use lowercase letters and numbers separated by single hyphens",
    );
  }
  const target = join(input.root, name);
  if (existsSync(target)) {
    throw new Error(`workflow package already exists: ${target}`);
  }

  const description =
    input.description?.trim() || `Manually authored ${titleFromName(name)} workflow`;
  const manifest = skeletonManifest(name, description);
  const stagingRoot = join(input.root, `.${name}.init-${process.pid}-${Date.now()}`);
  const stagingPackage = join(stagingRoot, name);
  const testPath = join(stagingPackage, "tests", "skeleton.yaml");
  try {
    mkdirSync(join(stagingPackage, "prompts"), { recursive: true });
    mkdirSync(join(stagingPackage, "scripts"), { recursive: true });
    mkdirSync(dirname(testPath), { recursive: true });
    writeFileSync(join(stagingPackage, "workflow.yaml"), stringify(manifest));
    writeFileSync(join(stagingPackage, "SKILL.md"), renderWorkflowSkillAdapter(manifest));
    writeFileSync(
      testPath,
      skeletonTest(`# ${titleFromName(name)}\n\nReplace this skeleton step with your workflow.\n`),
    );

    const pkg = loadWorkflowPackage(stagingPackage, input.scope);
    parseWorkflowTestCase(readFile(pkg.files, "tests/skeleton.yaml"), "tests/skeleton.yaml");
    mkdirSync(input.root, { recursive: true });
    renameSync(stagingPackage, target);
    rmSync(stagingRoot, { recursive: true, force: true });
    return {
      name,
      scope: input.scope,
      dir: target,
      files: ["workflow.yaml", "SKILL.md", "tests/skeleton.yaml"],
    };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function readFile(files: Array<{ path: string; content: string }>, path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`generated workflow file is missing: ${path}`);
  return file.content;
}
