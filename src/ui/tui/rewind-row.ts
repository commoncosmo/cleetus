import { formatAge } from "./format-age";

export interface RewindCheckpoint {
  turnNumber: number;
  userInput: string;
  ts: number;
}

export interface RewindRow {
  turnNumber: number;
  label: string;
  age: string;
}

const MAX_LABEL = 40;

function label(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= MAX_LABEL ? clean : `${clean.slice(0, MAX_LABEL - 1)}…`;
}

/** Picker rows, newest checkpoint first. `now` is the current epoch ms. */
export function rewindRows(cps: RewindCheckpoint[], now: number): RewindRow[] {
  return [...cps]
    .sort((a, b) => b.turnNumber - a.turnNumber)
    .map((c) => ({
      turnNumber: c.turnNumber,
      label: label(c.userInput),
      age: formatAge(now - c.ts),
    }));
}
