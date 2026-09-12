import { Box, type Key, Text, useInput } from "ink";
import { useTheme } from "../theme";

export type SpecDraftAction = "approve" | "revise" | "save" | "edit";

/** Key → action for the draft checkpoint. `esc` saves because the draft is already on disk:
 * "back" and "keep the file, stop here" are the same thing at this point. Case-insensitive. */
export function specDraftKeyAction(
  input: string,
  key: Pick<Key, "return" | "escape">,
): SpecDraftAction | null {
  if (key.return) return "approve";
  if (key.escape) return "save";
  switch (input.toLowerCase()) {
    case "a":
      return "approve";
    case "r":
      return "revise";
    case "s":
      return "save";
    case "e":
      return "edit";
    default:
      return null;
  }
}

export interface SpecDraftPromptProps {
  specPath: string;
  onApprove: () => void;
  onRevise: () => void;
  onSave: () => void;
  onEdit: () => void;
}

/** Inline control shown after `/spec` writes a draft. Enter/a approves the requirements only (the
 * execution chooser follows), r asks for a revision, s keeps the file and stops, e opens it in
 * $EDITOR and re-shows this prompt. */
export function SpecDraftPrompt(props: SpecDraftPromptProps) {
  const t = useTheme();
  useInput((input, key) => {
    const action = specDraftKeyAction(input, key);
    if (action === "approve") props.onApprove();
    else if (action === "revise") props.onRevise();
    else if (action === "save") props.onSave();
    else if (action === "edit") props.onEdit();
  });
  return (
    <Box flexDirection="column">
      <Text color={t.accent}>◇ Spec draft written to {props.specPath}</Text>
      <Text color={t.dim}>(enter/a approve · r revise · s spec only · e edit)</Text>
    </Box>
  );
}
