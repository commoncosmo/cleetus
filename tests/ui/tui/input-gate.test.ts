import { expect, test } from "bun:test";
import {
  type InputGateFlags,
  inputDisabled,
  terminalActivityState,
} from "../../../src/ui/tui/input-gate";

const allClear: InputGateFlags = {
  permissionPromptOpen: false,
  workflowPermissionPromptOpen: false,
  workflowInputPromptOpen: false,
  editorHandoffOpen: false,
  planApprovalPending: false,
  planOrchestratePending: false,
  taskListPending: false,
  bootstrapLocationPending: false,
  buildPromptPending: false,
  specDraftPending: false,
  specHandoffPending: false,
  modelPickerOpen: false,
  modePickerOpen: false,
  routePickerOpen: false,
  personaPickerOpen: false,
  effortPickerOpen: false,
  rewindPickerOpen: false,
  sessionPickerOpen: false,
  personalityPickerOpen: false,
  restoreOpen: false,
};

test("input is enabled when nothing modal is up — busy is not a flag at all", () => {
  expect(inputDisabled(allClear)).toBe(false);
  // Structural pin: the gate's contract has no `busy` key. If someone re-adds
  // busy-disabling, it cannot come back through this type.
  expect("busy" in allClear).toBe(false);
});

test("each modal condition alone disables input", () => {
  for (const key of Object.keys(allClear) as (keyof InputGateFlags)[]) {
    expect(inputDisabled({ ...allClear, [key]: true })).toBe(true);
  }
});

test("Terminal attention covers every modal and prompts that accept ordinary text", () => {
  expect(terminalActivityState(false, allClear)).toBe("clear");
  expect(terminalActivityState(true, allClear)).toBe("running");
  for (const key of Object.keys(allClear) as (keyof InputGateFlags)[]) {
    expect(terminalActivityState(true, { ...allClear, [key]: true })).toBe("waiting");
    expect(terminalActivityState(false, { ...allClear, [key]: true })).toBe("waiting");
  }
  expect(terminalActivityState(false, allClear, true)).toBe("waiting");
  expect(inputDisabled(allClear)).toBe(false);
});
