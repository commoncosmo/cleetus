import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { PATH_READING_TOOLS, type PermissionRule } from "../../permission/types";
import { useTheme } from "../theme";
import { type Buffer, backspace, fromText, insert, left, right } from "./editor";
import { buildGrantRule, defaultGrantInput, readEscapeQuickGrant } from "./permission-grant";

export type PermissionAction =
  | "allow_once"
  | "deny"
  | "allow_project"
  | "allow_global"
  | {
      kind: "grant";
      rule: Omit<PermissionRule, "decision">;
      scope: "project" | "global";
      decision: "allow" | "deny";
    };

export interface PermissionPromptProps {
  tool: string;
  summary: string;
  /** Resolved target path for write tools (enables the directory-broaden option). */
  targetPath?: string;
  /** Out-of-project READ prompt: [a]/[g] quick-grant a directory-scoped pathPrefix rule via
   *  readEscapeQuickGrant instead of the whole-tool allow_project/allow_global path — a plain
   *  "allow" here must never persist as "allow this tool everywhere". The "never" [!] flow IS
   *  offered here (a pathPrefix deny is safe — deny-beats-allow, Task 7). */
  readEscape?: boolean;
  /** Out-of-tree WRITE prompt (forced despite no targetPath — see cleetus.ts): that prompt's
   *  grant machinery is deliberately suppressed (no directory-broaden, no persisted rule), so
   *  the "never" [!] flow is not offered there either. */
  escapes?: boolean;
  onResolve: (action: PermissionAction) => void;
}

export function editedPermissionGrant(
  tool: string,
  edited: string,
  decision: "allow" | "deny",
  scope: "project" | "global",
): PermissionAction | null {
  const rule = buildGrantRule(tool, edited);
  if (!rule) return null;
  return { kind: "grant", rule, scope, decision };
}

/** Keep printable input only (Ink hands through raw control bytes). */
function printable(s: string): string {
  let out = "";
  for (const ch of s) if (ch.codePointAt(0)! >= 0x20) out += ch;
  return out;
}

export function PermissionPrompt({
  tool,
  summary,
  targetPath,
  readEscape,
  escapes,
  onResolve,
}: PermissionPromptProps) {
  const t = useTheme();
  const broadenPrefill = defaultGrantInput(tool, summary, targetPath);
  const [step, setStep] = useState<"main" | "edit" | "scope">("main");
  const [buf, setBuf] = useState<Buffer>(() => fromText(broadenPrefill ?? ""));
  const [ruleDecision, setRuleDecision] = useState<"allow" | "deny">("allow");

  const resolveEdited = (scope: "project" | "global") => {
    const action = editedPermissionGrant(tool, buf.text, ruleDecision, scope);
    if (action) onResolve(action);
    else setStep("main");
  };

  const isReadTool = PATH_READING_TOOLS.has(tool);
  const broadenLabel =
    tool === "bash"
      ? "[e]dit command → allow"
      : isReadTool
        ? "[d]ir → allow reads under a directory"
        : "[d]ir → allow edits in a directory";
  const broadenKey = tool === "bash" ? "e" : "d";
  // The out-of-tree write prompt's grant machinery is deliberately suppressed (unchanged);
  // the "never" flow rides the same persist path so it is withheld there too. Out-of-project
  // READ prompts (readEscape) DO offer it: a pathPrefix deny ("never read from this path") is
  // safe and part of the feature's decision-fatigue goal (deny-beats-allow, Task 7).
  const neverOffered = !escapes;

  useInput((char, key) => {
    if (step === "main") {
      if (char === "y") onResolve("allow_once");
      else if (char === "n") onResolve("deny");
      else if (char === "a" || char === "g") {
        if (readEscape) {
          // Out-of-project read: [a]/[g] must never persist a whole-tool allow. Quick-grant
          // is scoped to the same directory the [d]ir broaden flow would produce; if no
          // prefill can be derived, fall back to a one-time allow (nothing persisted).
          const rule = readEscapeQuickGrant(tool, summary, targetPath);
          if (rule)
            onResolve({
              kind: "grant",
              rule,
              scope: char === "a" ? "project" : "global",
              decision: "allow",
            });
          else onResolve("allow_once");
        } else {
          onResolve(char === "a" ? "allow_project" : "allow_global");
        }
      } else if (broadenPrefill && char === broadenKey) {
        setRuleDecision("allow");
        setStep("edit");
      } else if (neverOffered && char === "!") {
        setRuleDecision("deny");
        setStep(broadenPrefill ? "edit" : "scope");
      }
      return;
    }
    if (step === "edit") {
      if (key.escape) setStep("main");
      else if (key.return) {
        if (ruleDecision === "deny") resolveEdited("project");
        else setStep("scope");
      } else if (ruleDecision === "deny" && key.ctrl && char === "g") {
        resolveEdited("global");
      } else if (key.leftArrow) setBuf(left);
      else if (key.rightArrow) setBuf(right);
      else if (key.backspace || key.delete) setBuf(backspace);
      else if (char && !key.ctrl && !key.meta) {
        const text = printable(char);
        if (text) setBuf((b) => insert(b, text));
      }
      return;
    }
    // step === "scope"
    if (key.escape) setStep(broadenPrefill ? "edit" : "main");
    else if (char === "a" || char === "g") {
      if (ruleDecision === "deny" && !broadenPrefill) {
        onResolve({
          kind: "grant",
          rule: { tool },
          scope: char === "a" ? "project" : "global",
          decision: "deny",
        });
      } else resolveEdited(char === "a" ? "project" : "global");
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.warning} paddingX={1}>
      <Text bold color={t.warning}>
        Permission requested
      </Text>
      <Text>
        Tool: <Text bold>{tool}</Text>
      </Text>
      <Text>{summary}</Text>
      {step === "main" && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            [<Text color={t.success}>y</Text>]es [<Text color={t.error}>n</Text>]o [
            <Text color={t.accent}>a</Text>]llow project [<Text color={t.accentAlt}>g</Text>]lobal
          </Text>
          {readEscape && broadenPrefill && (
            <Text color={t.dim}>allow persists: reads under {broadenPrefill}</Text>
          )}
          {broadenPrefill && <Text color={t.dim}>{broadenLabel}</Text>}
          {neverOffered && (
            <Text color={t.dim}>
              [<Text color={t.error}>!</Text>] never (persist a deny rule)
            </Text>
          )}
        </Box>
      )}
      {step === "edit" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={t.dim}>
            {ruleDecision === "deny"
              ? tool === "bash"
                ? "Deny commands starting with:"
                : "Deny under:"
              : tool === "bash"
                ? "Allow commands starting with:"
                : isReadTool
                  ? "Allow reads under:"
                  : "Allow all edits under:"}
          </Text>
          <Text>
            {"> "}
            {buf.text.slice(0, buf.cursor)}
            <Text color={t.accent}>▏</Text>
            {buf.text.slice(buf.cursor)}
          </Text>
          <Text color={t.dim}>
            {ruleDecision === "deny"
              ? "[Enter] save project deny · [Ctrl+G] save global deny · [Esc] cancel"
              : "[Enter] continue · [Esc] cancel"}
          </Text>
        </Box>
      )}
      {step === "scope" && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            {ruleDecision === "deny"
              ? `Never allow: ${broadenPrefill ? buf.text : tool}`
              : tool === "bash"
                ? `Allow bash where command starts with: ${buf.text}`
                : isReadTool
                  ? `Allow reads under: ${buf.text}`
                  : `Allow edits under: ${buf.text}`}
          </Text>
          <Text>
            {ruleDecision === "deny" ? (
              <>
                [<Text color={t.accent}>a</Text>] save project deny [
                <Text color={t.accentAlt}>g</Text>] save global deny · [Esc] back
              </>
            ) : (
              <>
                [<Text color={t.accent}>a</Text>]llow project [<Text color={t.accentAlt}>g</Text>
                ]lobal · [Esc] back
              </>
            )}
          </Text>
        </Box>
      )}
    </Box>
  );
}
