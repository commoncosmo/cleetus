import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme";
import {
  type Buffer,
  EMPTY,
  backspace,
  down,
  fromText,
  insert,
  isMultiline,
  left,
  normalizeInput,
  right,
  up,
  visualLayout,
} from "./editor";
import { historyNext, historyPrev, verticalNavigationTarget } from "./history-nav";
import { joinForPrefill } from "./input-queue";
import { isClearInputKey, isNewlineKey } from "./keys";
import { SUGGEST_PAGE, suggestWindow } from "./suggest-window";

export interface Suggestion {
  display: string;
  value: string;
  /** When true, Enter inserts the value (like Tab) instead of submitting. */
  fillOnly?: boolean;
}

export interface InputSeed {
  text: string;
  /** Monotonic; a change means "apply this seed once". */
  key: number;
}

export interface InputProps {
  prompt: string;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  /** Returns completion candidates for the current line (empty when none apply). */
  complete?: (line: string) => Suggestion[];
  /** Submitted prompts, oldest first, recalled with Up/Down. */
  history?: string[];
  /** One-shot buffer replacement (queued-message pre-fill). Applied when `key` changes. */
  seed?: InputSeed | null;
  /** Clear-input chord pressed while the buffer is already empty. */
  onClearEmpty?: () => void;
}

export function Input({
  prompt,
  onSubmit,
  disabled,
  complete,
  history = [],
  seed,
  onClearEmpty,
}: InputProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const [buf, setBuf] = useState<Buffer>(EMPTY);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [dismissed, setDismissed] = useState(false);

  const appliedSeedKey = useRef(0);
  useEffect(() => {
    if (!seed || seed.key === appliedSeedKey.current) return;
    appliedSeedKey.current = seed.key;
    setBuf((b) => fromText(joinForPrefill(seed.text, b.text)));
    setSuggestIdx(0);
    setHistIdx(null);
    setDraft("");
    setDismissed(false);
  }, [seed]);

  // Recalled entries own Up/Down until edited. In particular, recalling `/help`
  // must not reopen slash autocomplete and trap navigation in its suggestion list.
  const suggestions = disabled || dismissed || histIdx !== null ? [] : (complete?.(buf.text) ?? []);
  const sel = Math.min(suggestIdx, Math.max(0, suggestions.length - 1));

  useInput((input, key) => {
    if (disabled) return;

    if (isClearInputKey(input, key)) {
      if (buf.text === "") onClearEmpty?.();
      setBuf(EMPTY);
      setSuggestIdx(0);
      setHistIdx(null);
      setDraft("");
      setDismissed(false);
      return;
    }

    if (key.tab && suggestions.length > 0) {
      const pick = suggestions[sel];
      if (pick) {
        setBuf(fromText(pick.value));
        setSuggestIdx(0);
        setHistIdx(null);
      }
      return;
    }

    if (key.escape) {
      if (suggestions.length > 0) {
        setDismissed(true);
      }
      return;
    }

    // Newline (Shift/Option+Enter, across terminal encodings) vs submit (plain Enter).
    if (isNewlineKey(input, key)) {
      setBuf((b) => insert(b, "\n"));
      setSuggestIdx(0);
      setHistIdx(null);
      return;
    }
    if (key.return) {
      if (suggestions.length > 0) {
        const pick = suggestions[sel]!;
        if (pick.fillOnly) {
          setBuf(fromText(pick.value));
          setSuggestIdx(0);
          setHistIdx(null);
          return;
        }
        setBuf(EMPTY);
        setSuggestIdx(0);
        setHistIdx(null);
        setDraft("");
        onSubmit(pick.value);
        return;
      }
      setBuf(EMPTY);
      setSuggestIdx(0);
      setHistIdx(null);
      setDraft("");
      onSubmit(buf.text);
      return;
    }

    // ↑/↓: recalled history keeps priority; otherwise navigate suggestions,
    // then the cursor in a multi-line buffer, then prompt history.
    if (key.upArrow) {
      const target = verticalNavigationTarget({
        suggestionCount: suggestions.length,
        multiline: isMultiline(buf),
        recalling: histIdx !== null,
      });
      if (target === "suggestions") {
        setSuggestIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (target === "cursor") {
        setBuf((b) => up(b));
        return;
      }
      const next = historyPrev({ value: buf.text, histIdx, draft }, history);
      setBuf(fromText(next.value));
      setHistIdx(next.histIdx);
      setDraft(next.draft);
      return;
    }
    if (key.downArrow) {
      const target = verticalNavigationTarget({
        suggestionCount: suggestions.length,
        multiline: isMultiline(buf),
        recalling: histIdx !== null,
      });
      if (target === "suggestions") {
        setSuggestIdx((i) => Math.min(suggestions.length - 1, i + 1));
        return;
      }
      if (target === "cursor") {
        setBuf((b) => down(b));
        return;
      }
      const next = historyNext({ value: buf.text, histIdx, draft }, history);
      setBuf(fromText(next.value));
      setHistIdx(next.histIdx);
      setDraft(next.draft);
      return;
    }

    if (key.leftArrow) {
      setBuf((b) => left(b));
      return;
    }
    if (key.rightArrow) {
      setBuf((b) => right(b));
      return;
    }

    if (key.backspace || key.delete) {
      setBuf((b) => backspace(b));
      setSuggestIdx(0);
      setHistIdx(null);
      setDismissed(false);
      return;
    }

    if (input && !key.ctrl && !key.meta && !key.tab) {
      const printable = normalizeInput(input);
      if (printable) {
        setBuf((b) => insert(b, printable));
        setSuggestIdx(0);
        setHistIdx(null);
        setDismissed(false);
      }
    }
  });

  const prefixLen = prompt.length + 1;
  // Reserve one column for the cursor block so an exactly-full row plus the
  // cursor never re-wraps past the terminal edge.
  const width = Math.max(1, (stdout?.columns ?? 80) - prefixLen - 1);
  const { rows: lines, cursorRow, cursorCol } = visualLayout(buf, width);
  const pad = " ".repeat(prefixLen);

  return (
    <Box flexDirection="column">
      {lines.map((line, row) => {
        const showCursor = !disabled && row === cursorRow;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, not identities
          <Box key={row}>
            <Text color={t.userInput}>{row === 0 ? `${prompt} ` : pad}</Text>
            {showCursor ? (
              <>
                <Text>{line.slice(0, cursorCol)}</Text>
                {/* Block cursor: cover the char in place (inverse) rather than
                    inserting a glyph, so the rest of the line doesn't shift. */}
                <Text inverse>{line[cursorCol] ?? " "}</Text>
                <Text>{line.slice(cursorCol + 1)}</Text>
              </>
            ) : (
              <Text>{line}</Text>
            )}
          </Box>
        );
      })}
      {suggestions.length > 0 &&
        (() => {
          const win = suggestWindow(suggestions.length, sel);
          const visible = suggestions.slice(win.offset, win.offset + SUGGEST_PAGE);
          return (
            <Box flexDirection="column">
              {win.aboveCount > 0 && <Text color={t.dim}> ↑ {win.aboveCount} more</Text>}
              {visible.map((s, i) => {
                const realIdx = win.offset + i;
                return (
                  <Text key={s.value} color={realIdx === sel ? t.accent : t.dim}>
                    {realIdx === sel ? "› " : "  "}
                    {s.display}
                  </Text>
                );
              })}
              {win.belowCount > 0 && <Text color={t.dim}> ↓ {win.belowCount} more</Text>}
              <Text color={t.dim}>
                {" "}
                tab to complete · ↑/↓ to choose · shift/opt+enter for newline
              </Text>
            </Box>
          );
        })()}
    </Box>
  );
}
