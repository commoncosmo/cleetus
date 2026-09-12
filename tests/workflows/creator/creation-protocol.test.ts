import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowCreatorController } from "../../../src/workflows/creator/controller";
import { WorkflowDraftStore } from "../../../src/workflows/creator/draft-store";
import type {
  WorkflowCreatorOutput,
  WorkflowRequirementsContract,
} from "../../../src/workflows/creator/types";
import { WorkflowStepRegistry } from "../../../src/workflows/step-registry";
import { dataSelectStep } from "../../../src/workflows/steps/data-select";

function registry(): WorkflowStepRegistry {
  const steps = new WorkflowStepRegistry();
  steps.register(dataSelectStep);
  return steps;
}

function draftOutput(response: string, outputStep = "select"): WorkflowCreatorOutput {
  return {
    response,
    phase: "draft",
    manifest: {
      schema_version: 1,
      name: "protocol-check",
      revision: 99,
      description: "Return a deterministic result.",
      inputs: { type: "object", properties: {}, additionalProperties: false },
      permissions: {},
      execution: { timeout: "10s" },
      steps: [
        {
          id: "select",
          uses: "data.select@1",
          with: { value: "ready", pointer: "" },
        },
      ],
      outputs: {
        result: {
          value: {
            ref: "step-output",
            step: outputStep,
            path: [],
          } as never,
          schema: { type: "string" },
        },
      },
      presentation: { output: "result" },
    },
    assumptions: [],
    unresolvedQuestions: [],
  };
}

describe("workflow creation blueprint protocol", () => {
  test("does not rerun the creator when retry cannot answer an open requirement question", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "creation-question-retry-")));
    let calls = 0;
    const model = {
      async respond(): Promise<WorkflowCreatorOutput> {
        calls++;
        return {
          response: "What fields should constraints contain?",
          phase: "questions",
          assumptions: [],
          unresolvedQuestions: ["What fields should constraints contain?"],
        };
      },
    };
    const controller = new WorkflowCreatorController(store, model, "Create workflows.", registry());
    const draft = controller.start({ name: "protocol-check" });
    const questions = await controller.respond(draft.id, "Review decision options.");

    expect(calls).toBe(1);
    const retried = await controller.retry(draft.id);
    expect(calls).toBe(1);
    expect(retried.updatedAt).toBe(questions.updatedAt);
    expect(retried.messages).toEqual(questions.messages);
    expect(retried.output?.unresolvedQuestions).toEqual([
      "What fields should constraints contain?",
    ]);

    retried.requirementsContract = {
      phase: "ready",
      response: "Requirements are complete.",
      purpose: "Review decision options.",
      desiredResult: "Present a recommendation.",
      inputFields: [],
      modelSteps: [],
      externalActions: [],
      secrets: [],
      presentation: "Markdown",
      assumptions: [],
      unresolvedQuestions: [],
    };
    store.save(retried);
    await controller.retry(draft.id);
    expect(calls).toBe(2);
  });

  test("persists the requirement transcript and rebuilds validation repair without the rejected candidate", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "creation-protocol-")));
    let calls = 0;
    let repairMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const requirementsContract: WorkflowRequirementsContract = {
      phase: "questions",
      response: "Should the result be plain text or Markdown?",
      purpose: "Return a deterministic result.",
      desiredResult: "",
      inputFields: [],
      modelSteps: [],
      externalActions: [],
      secrets: [],
      presentation: "",
      assumptions: [],
      unresolvedQuestions: ["result format"],
    };
    const model = {
      async respond(input: {
        creationProtocol?: string;
        messages: Array<{ role: "user" | "assistant"; content: string }>;
        requirementsContract?: WorkflowRequirementsContract;
      }): Promise<WorkflowCreatorOutput> {
        calls++;
        expect(input.creationProtocol).toBe("blueprint-v1");
        if (calls === 1) {
          return {
            response: "Should the result be plain text or Markdown?",
            phase: "questions",
            assumptions: [],
            unresolvedQuestions: ["result format"],
            requirementsContract,
          };
        }
        expect(input.requirementsContract).toEqual(requirementsContract);
        if (calls === 2) return draftOutput("Rejected candidate.", "missing");
        repairMessages = structuredClone(input.messages);
        return draftOutput("Replacement blueprint.");
      },
    };
    const firstController = new WorkflowCreatorController(
      store,
      model,
      "Create workflows.",
      registry(),
    );
    const draft = firstController.start({ name: "protocol-check", sessionId: "session-one" });

    expect(draft.creationProtocol).toBe("blueprint-v1");
    expect(draft.requirementMessages).toEqual([]);
    const questions = await firstController.respond(
      draft.id,
      "Create a workflow that returns a deterministic result.",
    );
    expect(questions.phase).toBe("questions");

    const restartedController = new WorkflowCreatorController(
      store,
      model,
      "Create workflows.",
      registry(),
    );
    const result = await restartedController.respond(draft.id, "Use Markdown.");

    expect(calls).toBe(3);
    expect(result.diagnostics).toEqual([]);
    expect(result.output?.response).toBe("Replacement blueprint.");
    expect(result.output?.manifest?.revision).toBe(1);
    expect(result.requirementMessages).toEqual([
      {
        role: "user",
        content: "Create a workflow that returns a deterministic result.",
      },
      {
        role: "assistant",
        content: "Should the result be plain text or Markdown?",
      },
      { role: "user", content: "Use Markdown." },
    ]);
    expect(repairMessages).toEqual([
      ...result.requirementMessages!,
      {
        role: "user",
        content: expect.stringContaining(
          "Discard the rejected candidate and rebuild one complete blueprint",
        ),
      },
    ]);
    expect(repairMessages.some((message) => message.content.includes("Rejected candidate."))).toBe(
      false,
    );
  });

  test("retry after restart discards every failed blueprint and retains legacy drafts unchanged", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "creation-retry-")));
    let calls = 0;
    let retryMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    const model = {
      async respond(input: {
        messages: Array<{ role: "user" | "assistant"; content: string }>;
      }): Promise<WorkflowCreatorOutput> {
        calls++;
        if (calls <= 2) return draftOutput(`Rejected candidate ${calls}.`, "missing");
        retryMessages = structuredClone(input.messages);
        return draftOutput("Clean retry blueprint.");
      },
    };
    const controller = new WorkflowCreatorController(store, model, "Create workflows.", registry());
    const draft = controller.start({ name: "protocol-check" });
    const failed = await controller.respond(draft.id, "Return the word ready.");

    expect(failed.creationProtocol).toBe("blueprint-v1");
    expect(failed.output?.response).toBe("Rejected candidate 2.");
    expect(failed.diagnostics.length).toBeGreaterThan(0);

    const restartedController = new WorkflowCreatorController(
      store,
      model,
      "Create workflows.",
      registry(),
    );
    const recovered = await restartedController.retry(draft.id);

    expect(recovered.diagnostics).toEqual([]);
    expect(recovered.output?.response).toBe("Clean retry blueprint.");
    expect(retryMessages.some((message) => message.role === "assistant")).toBe(false);
    expect(retryMessages.filter((message) => message.role === "user")[0]?.content).toBe(
      "Return the word ready.",
    );
    expect(retryMessages.at(-1)?.content).toContain(
      "Discard every previous candidate and assistant proposal",
    );

    const legacy = store.create({
      name: "legacy",
      scope: "project",
      creationProtocol: "legacy-full-package",
    });
    legacy.messages.push({ role: "user", content: "Keep this old draft." });
    store.save(legacy);
    expect(store.get(legacy.id)).toMatchObject({
      creationProtocol: "legacy-full-package",
      messages: [{ role: "user", content: "Keep this old draft." }],
    });
    expect(store.get(legacy.id)?.requirementMessages).toBeUndefined();
  });
});
