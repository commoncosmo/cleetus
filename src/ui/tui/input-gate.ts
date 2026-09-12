/**
 * The Input `disabled` gate. Everything that must own the keyboard while
 * open — the permission prompt, every picker, every pending choice prompt.
 *
 * Deliberately NO `busy` flag: typing while the agent works feeds the
 * input queue (Finding 9). Re-adding busy-disabling is a regression.
 */
export interface InputGateFlags {
  permissionPromptOpen: boolean;
  workflowPermissionPromptOpen: boolean;
  workflowInputPromptOpen: boolean;
  editorHandoffOpen: boolean;
  planApprovalPending: boolean;
  planOrchestratePending: boolean;
  taskListPending: boolean;
  bootstrapLocationPending: boolean;
  buildPromptPending: boolean;
  /** The two /spec checkpoints: the draft picker and the execution chooser. Both own the keyboard.
   * (The spec *revision* prompt is deliberately not here — the input stays live while it shows.) */
  specDraftPending: boolean;
  specHandoffPending: boolean;
  modelPickerOpen: boolean;
  modePickerOpen: boolean;
  routePickerOpen: boolean;
  personaPickerOpen: boolean;
  effortPickerOpen: boolean;
  rewindPickerOpen: boolean;
  sessionPickerOpen: boolean;
  personalityPickerOpen: boolean;
  restoreOpen: boolean;
}

export function inputDisabled(f: InputGateFlags): boolean {
  return Object.values(f).some(Boolean);
}
