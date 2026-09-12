import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../../src/providers/types";
import { activateWorkflowDraft } from "../../src/workflows/creator/activate";
import { WorkflowCreatorController } from "../../src/workflows/creator/controller";
import type { WorkflowCreatorReference } from "../../src/workflows/creator/creation-references";
import { WorkflowDraftStore } from "../../src/workflows/creator/draft-store";
import {
  WORKFLOW_CREATOR_BLUEPRINT_OUTPUT_SCHEMA,
  type WorkflowCreatorModel,
} from "../../src/workflows/creator/model";
import type { WorkflowCreatorOutput } from "../../src/workflows/creator/types";
import { WorkflowRunStore } from "../../src/workflows/journal";
import { WorkflowModelCallService } from "../../src/workflows/model-call";
import { WorkflowRegistry } from "../../src/workflows/registry";
import { WorkflowSchemaService } from "../../src/workflows/schema";
import { WorkflowService } from "../../src/workflows/service";
import { createBuiltinWorkflowStepRegistry } from "../../src/workflows/steps";
import type { JsonObject, JsonValue } from "../../src/workflows/types";

const input = (...path: string[]): WorkflowCreatorReference => ({ ref: "input", path });
const step = (id: string, ...path: string[]): WorkflowCreatorReference => ({
  ref: "step-output",
  step: id,
  path,
});

function outputValue(reference: WorkflowCreatorReference): never {
  return reference as never;
}

function testCase(
  name: string,
  inputs: JsonObject,
  mocks: NonNullable<WorkflowCreatorOutput["tests"]>[number]["case"]["mocks"],
  outputs: JsonObject,
) {
  return [
    {
      path: "tests/success.yaml",
      case: {
        schema_version: 1 as const,
        name,
        mode: "mock" as const,
        inputs,
        mocks,
        expect: { status: "succeeded" as const, outputs },
      },
    },
  ];
}

function repositoryBrief(): WorkflowCreatorOutput {
  const rendered =
    "## oven-sh/bun\n\nThe all-in-one JavaScript runtime.\n\n- Primary language: Zig\n- Stars: 100\n- Forks: 10\n- Open issues: 5\n- Default branch: main";
  return {
    response: "Repository brief is ready.",
    phase: "draft",
    manifest: {
      schema_version: 1,
      name: "repository-brief",
      revision: 45,
      description: "Fetch and render a public GitHub repository brief.",
      inputs: {
        type: "object",
        required: ["owner", "repository"],
        properties: {
          owner: { type: "string", minLength: 1 },
          repository: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      permissions: {},
      execution: { timeout: "1m" },
      steps: [
        {
          id: "fetch",
          uses: "http.request@1",
          with: {
            url: "https://api.github.com/repos/${inputs.owner}/${inputs.repository}",
            method: "GET",
            response: "json",
          },
        },
        {
          id: "select",
          uses: "data.select@1",
          with: { value: step("fetch"), pointer: "/body" },
        },
        {
          id: "validate",
          uses: "assert.schema@1",
          with: {
            value: step("select"),
            schema: {
              type: "object",
              required: [
                "full_name",
                "description",
                "language",
                "stargazers_count",
                "forks_count",
                "open_issues_count",
                "default_branch",
              ],
              properties: {
                full_name: { type: "string", minLength: 1 },
                description: { type: "string" },
                language: { type: "string" },
                stargazers_count: { type: "integer", minimum: 0 },
                forks_count: { type: "integer", minimum: 0 },
                open_issues_count: { type: "integer", minimum: 0 },
                default_branch: { type: "string", minLength: 1 },
              },
              additionalProperties: true,
            },
          },
        },
        {
          id: "render",
          uses: "text.template@1",
          with: {
            template:
              "## {{full_name}}\n\n{{description}}\n\n- Primary language: {{language}}\n- Stars: {{stargazers_count}}\n- Forks: {{forks_count}}\n- Open issues: {{open_issues_count}}\n- Default branch: {{default_branch}}",
            data: step("validate"),
          },
        },
      ],
      outputs: {
        brief: { value: outputValue(step("render")), schema: { type: "string" } },
      },
      presentation: { output: "brief" },
    },
    tests: testCase(
      "repository metadata",
      { owner: "oven-sh", repository: "bun" },
      [
        {
          step: "fetch",
          uses: "http.request@1",
          response: {
            status: 200,
            content_type: "application/json",
            final_url: "https://api.github.com/repos/oven-sh/bun",
            body: {
              full_name: "oven-sh/bun",
              description: "The all-in-one JavaScript runtime.",
              language: "Zig",
              stargazers_count: 100,
              forks_count: 10,
              open_issues_count: 5,
              default_branch: "main",
            },
          },
        },
      ],
      { brief: rendered },
    ),
    assumptions: [],
    unresolvedQuestions: [],
  };
}

const meetingPlan = {
  summary: "The team selected the explicit revision lifecycle.",
  decisions: ["Add a revise command"],
  actions: [{ description: "Document the lifecycle", owner: "Sam", priority: "high" }],
  open_questions: ["When should replacement expire?"],
};

function meetingActionPlan(): WorkflowCreatorOutput {
  const rendered =
    "## Workflow MVP review\n\nThe team selected the explicit revision lifecycle.\n\n### Actions\n- Document the lifecycle — Sam (high)\n\n### Open questions\n- When should replacement expire?\n";
  return {
    response: "Meeting action plan is ready.",
    phase: "draft",
    manifest: {
      schema_version: 1,
      name: "meeting-action-plan",
      revision: 1,
      description: "Turn meeting notes into a structured action plan.",
      inputs: {
        type: "object",
        required: ["meeting"],
        properties: {
          meeting: {
            type: "object",
            required: ["title", "notes", "participants"],
            properties: {
              title: { type: "string", minLength: 1 },
              notes: { type: "string", minLength: 1 },
              participants: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
            },
            additionalProperties: false,
          },
          preferences: {
            type: "object",
            properties: {
              maximum_actions: { type: "integer", minimum: 1, maximum: 20, default: 5 },
              include_open_questions: { type: "boolean", default: true },
            },
            additionalProperties: false,
            default: {},
          },
        },
        additionalProperties: false,
      },
      permissions: {},
      execution: { timeout: "3m" },
      steps: [
        {
          id: "plan",
          uses: "llm.generate@1",
          with: {
            prompt:
              "Create an action plan from meeting and preferences. Use null when an owner is unknown.",
            input: { meeting: input("meeting"), preferences: input("preferences") },
            output_schema: {
              type: "object",
              required: ["summary", "decisions", "actions", "open_questions"],
              properties: {
                summary: { type: "string" },
                decisions: { type: "array", items: { type: "string" } },
                actions: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["description", "owner", "priority"],
                    properties: {
                      description: { type: "string" },
                      owner: { anyOf: [{ type: "string" }, { type: "null" }] },
                      priority: { enum: ["high", "medium", "low"] },
                    },
                    additionalProperties: false,
                  },
                },
                open_questions: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
        },
        {
          id: "render",
          uses: "text.template@1",
          with: {
            template:
              "## {{title}}\n\n{{plan.summary}}\n\n### Actions\n{{#each plan.actions}}- {{this.description}} — {{this.owner}} ({{this.priority}})\n{{/each}}\n### Open questions\n{{#each plan.open_questions}}- {{this}}\n{{/each}}",
            data: { title: input("meeting", "title"), plan: step("plan") },
          },
        },
      ],
      outputs: {
        result: { value: outputValue(step("plan")), schema: { type: "object" } },
        brief: { value: outputValue(step("render")), schema: { type: "string" } },
      },
      presentation: { output: "brief" },
    },
    tests: testCase(
      "meeting plan",
      {
        meeting: {
          title: "Workflow MVP review",
          notes: "Choose an update experience.",
          participants: ["Sam", "Alex"],
        },
      },
      [{ step: "plan", uses: "llm.generate@1", value: meetingPlan }],
      { result: meetingPlan, brief: rendered },
    ),
    assumptions: [],
    unresolvedQuestions: [],
  };
}

function githubAccountBrief(): WorkflowCreatorOutput {
  const rendered =
    "## octocat\n\nThe Octocat\n\n- Public repositories: 8\n- Private repositories: 0\n- Account: https://github.com/octocat";
  return {
    response: "GitHub account brief is ready.",
    phase: "draft",
    manifest: {
      schema_version: 1,
      name: "github-account-brief",
      revision: 1,
      description: "Render a limited authenticated GitHub account summary.",
      inputs: {},
      secrets: {
        github_token: {
          source: "env",
          name: "CLEETUS_WORKFLOW_GITHUB_TOKEN",
        },
      },
      permissions: {},
      execution: { timeout: "1m" },
      steps: [
        {
          id: "fetch",
          uses: "http.request@1",
          with: {
            url: "https://api.github.com/user",
            method: "GET",
            headers: { Authorization: "Bearer ${secrets.github_token}" },
            response: "json",
          },
        },
        {
          id: "account",
          uses: "data.select@1",
          with: { value: step("fetch"), pointer: "/body" },
        },
        {
          id: "private-count",
          uses: "data.select@1",
          with: {
            value: step("account"),
            pointer: "/total_private_repos",
            default: 0,
          },
        },
        {
          id: "render",
          uses: "text.template@1",
          with: {
            template:
              "## {{account.login}}\n\n{{account.name}}\n\n- Public repositories: {{account.public_repos}}\n- Private repositories: {{private_count}}\n- Account: {{account.html_url}}",
            data: { account: step("account"), private_count: step("private-count") },
          },
        },
      ],
      outputs: {
        summary: { value: outputValue(step("render")), schema: { type: "string" } },
      },
      presentation: { output: "summary" },
    },
    tests: testCase(
      "account without private count",
      {},
      [
        {
          step: "fetch",
          uses: "http.request@1",
          response: {
            status: 200,
            content_type: "application/json",
            final_url: "https://api.github.com/user",
            body: {
              login: "octocat",
              name: "The Octocat",
              public_repos: 8,
              html_url: "https://github.com/octocat",
            },
          },
        },
      ],
      { summary: rendered },
    ),
    assumptions: [],
    unresolvedQuestions: [],
  };
}

const inventory = {
  package_name: "cleetus",
  source_files: 342,
  test_files: 275,
  documentation_files: 18,
  detected_languages: ["TypeScript", "Markdown"],
};

function workspaceInventory(): WorkflowCreatorOutput {
  const rendered =
    "## cleetus\n\n- Source files: 342\n- Test files: 275\n- Documentation files: 18\n- Languages: TypeScript Markdown ";
  return {
    response: "Workspace inventory is ready.",
    phase: "draft",
    manifest: {
      schema_version: 1,
      name: "workspace-inventory",
      revision: 1,
      description: "Inspect the project with a packaged Bun script.",
      inputs: { type: "object", properties: {}, additionalProperties: false },
      permissions: { filesystem: { read: ["$project/**"] } },
      execution: { timeout: "1m" },
      steps: [
        {
          id: "inspect",
          uses: "command.run@1",
          with: {
            program: "bun",
            args: ["run", "./scripts/workspace-inventory.ts"],
            output: "json",
          },
        },
        {
          id: "validate",
          uses: "assert.schema@1",
          with: {
            value: step("inspect", "stdout"),
            schema: {
              type: "object",
              required: [
                "package_name",
                "source_files",
                "test_files",
                "documentation_files",
                "detected_languages",
              ],
              properties: {
                package_name: { type: "string" },
                source_files: { type: "integer", minimum: 0 },
                test_files: { type: "integer", minimum: 0 },
                documentation_files: { type: "integer", minimum: 0 },
                detected_languages: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
        },
        {
          id: "render",
          uses: "text.template@1",
          with: {
            template:
              "## {{package_name}}\n\n- Source files: {{source_files}}\n- Test files: {{test_files}}\n- Documentation files: {{documentation_files}}\n- Languages: {{#each detected_languages}}{{this}} {{/each}}",
            data: step("validate"),
          },
        },
      ],
      outputs: {
        inventory: { value: outputValue(step("validate")), schema: { type: "object" } },
        summary: { value: outputValue(step("render")), schema: { type: "string" } },
      },
      presentation: { output: "summary" },
    },
    resources: [
      {
        path: "scripts/workspace-inventory.ts",
        content: `console.log(${JSON.stringify(JSON.stringify(inventory))});\n`,
      },
    ],
    tests: testCase(
      "workspace inventory",
      {},
      [{ step: "inspect", uses: "command.run@1", stdout: inventory }],
      { inventory, summary: rendered },
    ),
    assumptions: [],
    unresolvedQuestions: [],
  };
}

const proposal = {
  choice: "Add revise",
  rationale: ["It makes intent explicit."],
  risks: ["It adds command surface."],
  assumptions: ["Revision history remains immutable."],
};
const critique = {
  recommendation: "Add revise",
  confidence: "high",
  supporting_points: ["The lifecycle is explicit."],
  concerns: ["Document replacement confirmation."],
  next_actions: ["Publish the revision guide."],
};

function decisionReview(): WorkflowCreatorOutput {
  const rendered =
    "## Add revise\n\nConfidence: high\n\n### Supporting points\n- The lifecycle is explicit.\n\n### Concerns\n- Document replacement confirmation.\n\n### Next actions\n- Publish the revision guide.\n";
  const optionSchema = {
    type: "object",
    required: ["name", "advantages", "disadvantages"],
    properties: {
      name: { type: "string", minLength: 1 },
      advantages: { type: "array", items: { type: "string" } },
      disadvantages: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  };
  return {
    response: "Decision review is ready.",
    phase: "draft",
    manifest: {
      schema_version: 1,
      name: "decision-review",
      revision: 1,
      description: "Propose and independently critique a structured decision.",
      inputs: {
        type: "object",
        required: ["question", "options", "constraints"],
        properties: {
          question: { type: "string", minLength: 1 },
          options: { type: "array", minItems: 2, items: optionSchema },
          constraints: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      permissions: {},
      execution: { timeout: "5m" },
      steps: [
        {
          id: "recommend",
          uses: "llm.generate@1",
          with: {
            prompt: "Propose a decision from question, options, and constraints.",
            input: {
              question: input("question"),
              options: input("options"),
              constraints: input("constraints"),
            },
            output_schema: {
              type: "object",
              required: ["choice", "rationale", "risks", "assumptions"],
              properties: {
                choice: { type: "string" },
                rationale: { type: "array", items: { type: "string" } },
                risks: { type: "array", items: { type: "string" } },
                assumptions: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
        },
        {
          id: "critique",
          uses: "llm.generate@1",
          with: {
            prompt: "Independently critique the proposal and produce a refined recommendation.",
            input: {
              question: input("question"),
              options: input("options"),
              constraints: input("constraints"),
              proposal: step("recommend"),
            },
            output_schema: {
              type: "object",
              required: [
                "recommendation",
                "confidence",
                "supporting_points",
                "concerns",
                "next_actions",
              ],
              properties: {
                recommendation: { type: "string" },
                confidence: { enum: ["low", "medium", "high"] },
                supporting_points: { type: "array", items: { type: "string" } },
                concerns: { type: "array", items: { type: "string" } },
                next_actions: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
        },
        {
          id: "render",
          uses: "text.template@1",
          with: {
            template:
              "## {{recommendation}}\n\nConfidence: {{confidence}}\n\n### Supporting points\n{{#each supporting_points}}- {{this}}\n{{/each}}\n### Concerns\n{{#each concerns}}- {{this}}\n{{/each}}\n### Next actions\n{{#each next_actions}}- {{this}}\n{{/each}}",
            data: step("critique"),
          },
        },
      ],
      outputs: {
        recommendation: {
          value: outputValue(step("critique")),
          schema: { type: "object" },
        },
        review: { value: outputValue(step("render")), schema: { type: "string" } },
      },
      presentation: { output: "review" },
    },
    tests: testCase(
      "decision review",
      {
        question: "Which update experience should Cleetus provide?",
        options: [
          {
            name: "Reuse create",
            advantages: ["No new command"],
            disadvantages: ["Intent is unclear"],
          },
          {
            name: "Add revise",
            advantages: ["Explicit lifecycle"],
            disadvantages: ["Larger command surface"],
          },
        ],
        constraints: ["Preserve revision history"],
      },
      [
        { step: "recommend", uses: "llm.generate@1", value: proposal },
        { step: "critique", uses: "llm.generate@1", value: critique },
      ],
      { recommendation: critique, review: rendered },
    ),
    assumptions: [],
    unresolvedQuestions: [],
  };
}

interface AcceptanceCase {
  output: () => WorkflowCreatorOutput;
  inputs: JsonObject;
  presented: string;
}

const cases: AcceptanceCase[] = [
  {
    output: repositoryBrief,
    inputs: { owner: "oven-sh", repository: "bun" },
    presented: "brief",
  },
  {
    output: meetingActionPlan,
    inputs: {
      meeting: {
        title: "Workflow MVP review",
        notes: "Choose an update experience.",
        participants: ["Sam", "Alex"],
      },
    },
    presented: "brief",
  },
  { output: githubAccountBrief, inputs: {}, presented: "summary" },
  { output: workspaceInventory, inputs: {}, presented: "summary" },
  {
    output: decisionReview,
    inputs: {
      question: "Which update experience should Cleetus provide?",
      options: [
        {
          name: "Reuse create",
          advantages: ["No new command"],
          disadvantages: ["Intent is unclear"],
        },
        {
          name: "Add revise",
          advantages: ["Explicit lifecycle"],
          disadvantages: ["Larger command surface"],
        },
      ],
      constraints: ["Preserve revision history"],
    },
    presented: "review",
  },
];

function runtimeProvider(): Provider {
  return {
    async *chat(options) {
      const request = options.messages.map((message) => message.content).join("\n");
      const value = request.includes("Independently critique")
        ? critique
        : request.includes("Propose a decision")
          ? proposal
          : meetingPlan;
      yield { type: "text-delta", text: JSON.stringify(value) };
      yield { type: "finish", reason: "stop" };
    },
    async listModels() {
      return [];
    },
    async embed() {
      return [];
    },
  };
}

describe("blueprint-v1 acceptance corpus", () => {
  for (const acceptance of cases) {
    const expected = acceptance.output();
    const name = expected.manifest!.name;
    test(`${name} creates, reviews, activates, tests, dry-runs, executes, and journals`, async () => {
      const root = mkdtempSync(join(tmpdir(), `workflow-blueprint-${name}-`));
      const workflowsRoot = join(root, ".cleetus", "workflows");
      mkdirSync(workflowsRoot, { recursive: true });
      const store = new WorkflowDraftStore(workflowsRoot);
      let creatorCalls = 0;
      let retryMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
      const creatorModel: WorkflowCreatorModel = {
        async respond(modelInput) {
          creatorCalls++;
          if (name === "workspace-inventory" && creatorCalls <= 2) {
            return {
              ...acceptance.output(),
              response: `Rejected legacy fixture ${creatorCalls}.`,
              resources: [
                ...(acceptance.output().resources ?? []),
                { path: "tests/legacy.yaml", content: "{}" },
              ],
            };
          }
          if (name === "workspace-inventory") {
            retryMessages = structuredClone(modelInput.messages);
          }
          return acceptance.output();
        },
      };
      const calls = new WorkflowModelCallService(() => runtimeProvider());
      const registry = (packageDir: string, journal?: WorkflowRunStore) =>
        createBuiltinWorkflowStepRegistry({
          packageDir,
          journal,
          defaultModel: { provider: "fake", model: "fake-model" },
          modelCalls: calls,
          transport: async (url) => {
            const body =
              url.pathname === "/user"
                ? {
                    login: "octocat",
                    name: "The Octocat",
                    public_repos: 8,
                    html_url: "https://github.com/octocat",
                  }
                : {
                    full_name: "oven-sh/bun",
                    description: "The all-in-one JavaScript runtime.",
                    language: "Zig",
                    stargazers_count: 100,
                    forks_count: 10,
                    open_issues_count: 5,
                    default_branch: "main",
                  };
            return {
              status: 200,
              headers: { get: () => "application/json" },
              text: async () => JSON.stringify(body),
              dispose() {},
            };
          },
          sandbox: {
            async exec() {
              return {
                stdout: JSON.stringify(inventory),
                stderr: "",
                exitCode: 0,
                timedOut: false,
                cancelled: false,
                survivors: [],
              };
            },
            async dispose() {},
            writeRoot: () => null,
          },
        });
      const controller = new WorkflowCreatorController(
        store,
        creatorModel,
        "Create strict workflows.",
        (packageDir) => registry(packageDir),
      );
      const schemaIssues = new WorkflowSchemaService()
        .compile(WORKFLOW_CREATOR_BLUEPRINT_OUTPUT_SCHEMA, "blueprint")
        .validate(expected as unknown as JsonValue);
      expect(schemaIssues).toEqual([]);

      const draft = controller.start({ name, sessionId: `${name}-session` });
      expect(draft.creationProtocol).toBe("blueprint-v1");
      let reviewed = await controller.respond(draft.id, `Create ${name} as specified.`);
      if (name === "workspace-inventory") {
        expect(reviewed.diagnostics[0]?.message).toContain("structured tests field");
        const restarted = new WorkflowCreatorController(
          store,
          creatorModel,
          "Create strict workflows.",
          (packageDir) => registry(packageDir),
        );
        reviewed = await restarted.retry(draft.id);
        expect(creatorCalls).toBe(3);
        expect(retryMessages.at(-1)?.content).toContain("[Host retry rebase]");
        expect(
          retryMessages.some((message) => message.content.includes("Rejected legacy fixture")),
        ).toBe(false);
      }
      expect(reviewed.diagnostics).toEqual([]);
      expect(reviewed.output?.manifest?.name).toBe(name);
      expect(reviewed.output?.manifest?.revision).toBe(1);
      expect(reviewed.output?.manifest?.presentation?.output).toBe(acceptance.presented);
      expect(reviewed.output?.authority?.derived.length).toBeGreaterThanOrEqual(0);
      if (Object.keys(acceptance.inputs).length === 0) {
        expect(reviewed.output?.manifest?.inputs).toEqual({
          type: "object",
          properties: {},
          additionalProperties: false,
        });
      }

      activateWorkflowDraft({
        draftPackageDir: controller.packageDir(reviewed),
        activeRoot: workflowsRoot,
        scope: "project",
        steps: (packageDir) => registry(packageDir),
      });
      const service = new WorkflowService({
        registry: new WorkflowRegistry({
          projectDir: root,
          globalDir: join(root, "global"),
        }),
        workspace: root,
        environment: { CLEETUS_WORKFLOW_GITHUB_TOKEN: "test-token" },
        authorize: async () => "allow_once",
        openStore: () => new WorkflowRunStore(join(root, ".cleetus", `${name}.db`)),
        stepRegistry(pkg, journal) {
          return registry(pkg.dir, journal);
        },
      });

      expect(service.validate(name).issues).toEqual([]);
      expect((await service.test(name)).every((result) => result.passed)).toBe(true);
      expect(service.dryRun(name, acceptance.inputs).steps.length).toBe(
        expected.manifest!.steps.length,
      );
      const result = await service.run({ name, inputs: acceptance.inputs });
      expect(result.status).toBe("succeeded");
      expect(result.outputs).toHaveProperty(acceptance.presented);
      expect(service.history({ workflowName: name })).toHaveLength(1);
    });
  }
});
