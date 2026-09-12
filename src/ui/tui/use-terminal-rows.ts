import { useStdout } from "ink";
import { useEffect, useState } from "react";

/** A usable terminal row count: the raw value if finite and positive (floored), else `fallback`
 *  (no TTY, or a stream that does not report rows). Pure. */
export function normalizeRows(raw: number | undefined, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Current terminal row count, re-rendering the caller on SIGWINCH/resize. `useStdout` exposes the
 *  stream but does not re-render on resize, so we subscribe to `resize` ourselves. */
export function useTerminalRows(fallback = 24): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(() => normalizeRows(stdout?.rows, fallback));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setRows(normalizeRows(stdout.rows, fallback));
    onResize(); // sync once in case rows changed between initial state and effect
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, fallback]);
  return rows;
}
