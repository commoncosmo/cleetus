/** One line within a hunk. `context` lines must match the file (and are emitted from the FILE's
 *  actual text, preserving its whitespace); `del` lines are removed; `add` lines are inserted. */
export interface HunkLine {
  kind: "context" | "del" | "add";
  text: string;
}

export interface PatchHunk {
  lines: HunkLine[];
}

export type ParsedPatch =
  | { op: "update"; path: string; hunks: PatchHunk[] }
  | { op: "add"; path: string; lines: string[] };

export interface ParseError {
  error: string;
}

const FILE_HEADER = /^\*\*\*\s+(Update|Add|Delete) File:\s*(.+?)\s*$/;
const MOVE_HEADER = /^\*\*\*\s+Move to:/;

/** Lightweight path extraction for the permission layer (no full parse). */
export function patchTargetPath(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = FILE_HEADER.exec(line);
    if (m && (m[1] === "Update" || m[1] === "Add")) return m[2]!;
  }
  return null;
}

/** Parse a single-file `*** Begin Patch` envelope. Returns a ParseError on any problem. */
export function parsePatch(text: string): ParsedPatch | ParseError {
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => l.trim() === "*** Begin Patch");
  const end = lines.findIndex((l) => l.trim() === "*** End Patch");
  if (begin === -1 || end === -1 || end <= begin) {
    return { error: "patch must be wrapped in '*** Begin Patch' / '*** End Patch'" };
  }
  const body = lines.slice(begin + 1, end);

  let headerIdx = -1;
  let op: "update" | "add" | "delete" | null = null;
  let path = "";
  for (let i = 0; i < body.length; i++) {
    const line = body[i]!;
    if (MOVE_HEADER.test(line)) {
      return { error: "apply_patch does not support '*** Move to:'; rename via bash instead" };
    }
    const m = FILE_HEADER.exec(line);
    if (m) {
      if (headerIdx !== -1) {
        return { error: "apply_patch handles one file per call; split into separate patches" };
      }
      headerIdx = i;
      op = m[1]!.toLowerCase() as "update" | "add" | "delete";
      path = m[2]!;
    }
  }
  if (headerIdx === -1 || !op) {
    return { error: "patch has no '*** Update File:' or '*** Add File:' section" };
  }
  if (op === "delete") {
    return { error: "apply_patch does not support '*** Delete File:'; remove via bash instead" };
  }
  if (path.trim() === "") {
    return { error: "the '*** Update/Add File:' header is missing a file path" };
  }

  const section = body.slice(headerIdx + 1);

  if (op === "add") {
    const content: string[] = [];
    for (const line of section) {
      if (line.startsWith("+")) content.push(line.slice(1));
      // A blank line becomes a blank line in the new file (models often omit the `+` on empties).
      else if (line.trim() === "") content.push("");
      else return { error: `Add File lines must start with '+': '${line}'` };
    }
    if (content.length === 0) return { error: "Add File has no content" };
    return { op: "add", path, lines: content };
  }

  // op === "update": split into hunks at '@@' markers, preserving line ops in order.
  const hunks: PatchHunk[] = [];
  let cur: HunkLine[] = [];
  const flush = () => {
    if (cur.length) hunks.push({ lines: cur });
    cur = [];
  };
  for (const line of section) {
    if (line.startsWith("@@")) {
      flush();
      continue;
    }
    if (line.startsWith("+")) cur.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) cur.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) cur.push({ kind: "context", text: line.slice(1) });
    // Lenient: an empty or unprefixed line is treated as context.
    else cur.push({ kind: "context", text: line });
  }
  flush();
  if (hunks.length === 0) return { error: "Update File has no hunks" };
  return { op: "update", path, hunks };
}
