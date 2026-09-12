import { expect, test } from "bun:test";
import {
  type RosterInput,
  buildModelRoster,
  formatModelRoster,
  formatOrchestrationRoles,
} from "../../../src/ui/tui/model-roster";

const active = { provider: "lmstudio", model: "gemma-4-26b-a4b" };

function input(orch: Partial<RosterInput["orchestration"]>): RosterInput {
  return {
    active,
    orchestration: {
      enabled: false,
      orchestratorModel: "",
      orchestratorProvider: "",
      workerModel: "",
      workerProvider: "",
      ...orch,
    },
  };
}

test("orchestration off → single, label-less session entry with its provider", () => {
  expect(buildModelRoster(input({ enabled: false }))).toEqual([
    { label: "", model: "gemma-4-26b-a4b", provider: "lmstudio", fromSession: false },
  ]);
  expect(formatModelRoster(input({ enabled: false }))).toBe("gemma-4-26b-a4b (lmstudio)");
});

test("orchestration on, pinned roles → planner/worker show their own provider", () => {
  const line = formatModelRoster(
    input({
      enabled: true,
      orchestratorModel: "nemotron3:33b",
      orchestratorProvider: "lab_ollama",
      workerModel: "north-mini-code-1.0:mlx-mxfp8",
      workerProvider: "lab_ollama",
    }),
  );
  expect(line).toBe(
    "chat gemma-4-26b-a4b (lmstudio) · planner nemotron3:33b (lab_ollama) · worker north-mini-code-1.0:mlx-mxfp8 (lab_ollama)",
  );
});

test("orchestration on, unpinned roles → planner/worker tagged (session)", () => {
  const roster = buildModelRoster(input({ enabled: true }));
  expect(roster.map((r) => r.fromSession)).toEqual([false, true, true]);
  expect(formatModelRoster(input({ enabled: true }))).toBe(
    "chat gemma-4-26b-a4b (lmstudio) · planner gemma-4-26b-a4b (session) · worker gemma-4-26b-a4b (session)",
  );
});

test("kickoff roles: planner+worker only, empty when orchestration off", () => {
  expect(formatOrchestrationRoles(input({ enabled: false }))).toBe("");
  expect(
    formatOrchestrationRoles(
      input({
        enabled: true,
        orchestratorModel: "nemotron3:33b",
        orchestratorProvider: "lab_ollama",
        workerModel: "north-mini",
        workerProvider: "lab_ollama",
      }),
    ),
  ).toBe("planner nemotron3:33b (lab_ollama) · worker north-mini (lab_ollama)");
});

test("a pinned model with no explicit provider inherits the session provider", () => {
  const [, planner] = buildModelRoster(
    input({ enabled: true, orchestratorModel: "nemotron3:33b", orchestratorProvider: "" }),
  );
  expect(planner).toEqual({
    label: "planner",
    model: "nemotron3:33b",
    provider: "lmstudio",
    fromSession: false,
  });
});

test("prefixes orch:off when orchestration is configured but disabled", () => {
  const line = formatModelRoster({
    active: { provider: "lm", model: "gemma" },
    orchestration: {
      enabled: false,
      configured: true,
      orchestratorModel: "",
      orchestratorProvider: "",
      workerModel: "",
      workerProvider: "",
    },
  });
  expect(line.startsWith("orch:off")).toBe(true);
  expect(line).toContain("gemma");
});

test("does NOT show orch:off when orchestration was never configured", () => {
  const line = formatModelRoster({
    active: { provider: "lm", model: "gemma" },
    orchestration: {
      enabled: false,
      configured: false,
      orchestratorModel: "",
      orchestratorProvider: "",
      workerModel: "",
      workerProvider: "",
    },
  });
  expect(line.includes("orch:off")).toBe(false);
});

test("does not show orch:off when orchestration is ON (roles already imply on)", () => {
  const line = formatModelRoster({
    active: { provider: "lm", model: "gemma" },
    orchestration: {
      enabled: true,
      configured: true,
      orchestratorModel: "nemo",
      orchestratorProvider: "oll",
      workerModel: "mini",
      workerProvider: "oll",
    },
  });
  expect(line.includes("orch:off")).toBe(false);
  expect(line).toContain("planner");
});
