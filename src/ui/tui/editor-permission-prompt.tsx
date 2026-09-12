import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme";

export interface EditorPermissionPromptProps {
  editor: string;
  targets: string[];
  onResolve: (allowed: boolean) => void;
}

export function EditorPermissionPrompt(props: EditorPermissionPromptProps) {
  const t = useTheme();
  useInput((input, key) => {
    if (input === "y" || input === "Y" || key.return) props.onResolve(true);
    else if (input === "n" || input === "N" || key.escape) props.onResolve(false);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.warning} paddingX={1}>
      <Text bold color={t.warning}>
        External editor access requested
      </Text>
      <Text>
        Editor: <Text bold>{props.editor}</Text>
      </Text>
      {props.targets.map((target) => (
        <Text key={target}>Target: {target}</Text>
      ))}
      <Text color={t.dim}>Cleetus permissions do not apply to the editor process.</Text>
      <Text>
        [<Text color={t.success}>y</Text>/enter] allow once [<Text color={t.error}>n</Text>/esc]
        cancel
      </Text>
    </Box>
  );
}
