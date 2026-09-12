import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { type Catalog, catalogEntries, fetchCatalog } from "../../providers/catalog";
import type { ProviderRegistry } from "../../providers/registry";
import { useTheme } from "../theme";
import { listWindow, modalBudget } from "./stream-window";
import { useTerminalRows } from "./use-terminal-rows";

export interface ModelPickerModalProps {
  providers: ProviderRegistry;
  active?: { provider: string; model: string };
  onSelect: (provider: string, model: string) => void;
  onCancel: () => void;
}

/** Upper bound on visible rows; a short terminal shrinks it further via {@link modalBudget}. */
const PAGE = 10;

export function ModelPickerModal(props: ModelPickerModalProps) {
  const t = useTheme();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [idx, setIdx] = useState(0);
  const termRows = useTerminalRows();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cat = await fetchCatalog(props.providers);
      if (cancelled) return;
      setCatalog(cat);
      const entries = catalogEntries(cat);
      const start = props.active
        ? entries.findIndex(
            (e) => e.provider === props.active!.provider && e.model === props.active!.model,
          )
        : 0;
      setIdx(start > 0 ? start : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.providers, props.active]);

  const entries = catalog ? catalogEntries(catalog) : [];
  const multi = (catalog?.length ?? 0) > 1;
  const errored = catalog?.filter((c) => c.error).map((c) => c.provider) ?? [];

  useInput((_char, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (entries.length === 0) return;
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(entries.length - 1, i + 1));
    else if (key.return) {
      const e = entries[idx];
      if (e) props.onSelect(e.provider, e.model);
    }
  });

  if (!catalog) return <Text>loading models…</Text>;
  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={t.error}>no models available</Text>
        {errored.length > 0 && <Text color={t.dim}>(unreachable: {errored.join(", ")})</Text>}
        <Text color={t.dim}>esc to cancel</Text>
      </Box>
    );
  }

  // Keep the selection in view, bounded by both PAGE and what the terminal can actually show —
  // overflowing the viewport puts Ink into its full-screen-clear branch on every frame.
  const view = listWindow(entries, idx, Math.min(PAGE, modalBudget(termRows)));

  return (
    <Box flexDirection="column">
      <Text>Select a model (↑/↓ move, enter select, esc cancel):</Text>
      {view.above > 0 && <Text color={t.dim}> ↑ {view.above} more</Text>}
      {view.items.map((e, i) => {
        const selected = i === view.selected;
        return (
          <Text key={`${e.provider}/${e.model}`} color={selected ? t.accent : undefined}>
            {selected ? "› " : "  "}
            {e.model}
            {multi ? <Text color={t.dim}> ({e.provider})</Text> : null}
          </Text>
        );
      })}
      {view.below > 0 && <Text color={t.dim}> ↓ {view.below} more</Text>}
      {errored.length > 0 && <Text color={t.dim}>(unreachable: {errored.join(", ")})</Text>}
    </Box>
  );
}
