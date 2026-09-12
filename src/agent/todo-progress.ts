import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { TodoItem } from "../tools/types";
import type { VerificationResult } from "./types";

export interface SeededTodoContract {
  expectedFiles: string[];
  verification: Array<"test" | "quality" | "launch" | "render">;
}

function cleanInline(value: string): string {
  return value
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/^\.\//, "")
    .replace(/[),.;:]+$/, "");
}

function looksLikeProjectPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("../") &&
    !value.includes("://") &&
    !/[\s*{}[\]]/.test(value) &&
    (value.includes("/") || /^\.[\w.-]+$/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value))
  );
}

/** Extract only an explicit Markdown file-summary table. This is intentionally narrower than
 * every code span in a plan: examples such as `.env`, output directories, and command arguments
 * are not necessarily promised deliverables. */
export function explicitPlanFiles(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const files = new Set<string>();
  let inSummary = false;
  let sawTable = false;
  for (const line of lines) {
    if (/^#{1,6}\s+.*\b(?:file\s+summary|summary\s+of\s+files)\b/i.test(line)) {
      inSummary = true;
      sawTable = false;
      continue;
    }
    if (!inSummary) continue;
    if (/^#{1,6}\s+/.test(line)) break;
    if (!line.trim()) {
      if (sawTable) break;
      continue;
    }
    if (!line.trimStart().startsWith("|")) {
      if (sawTable) break;
      continue;
    }
    sawTable = true;
    const first = line.split("|")[1]?.trim() ?? "";
    if (/^(?:file|[-: ]+)$/i.test(first)) continue;
    const path = cleanInline(first.replaceAll("**", ""));
    if (looksLikeProjectPath(path)) files.add(path);
  }
  return [...files];
}

function finalVerificationSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let start = lines.findIndex((line) =>
    /^#{1,6}\s+(?:Step\s+\d+\s*[—:.-]?\s*)?.*\b(?:full suite|final)\s+verification\b/i.test(line),
  );
  if (start < 0) {
    const numberedSteps = lines
      .map((line, index) => ({
        index,
        match: line.match(/^#{1,6}\s+(?:Step\s+)?\d+\s*[.)—:.-]?\s*(.*)$/i),
      }))
      .filter((entry): entry is { index: number; match: RegExpMatchArray } => entry.match !== null);
    const finalStep = numberedSteps.at(-1);
    if (finalStep && /\bverification\b/i.test(finalStep.match[1] ?? "")) {
      start = finalStep.index;
    }
  }
  if (start < 0) return "";
  const level = lines[start]!.match(/^(#+)/)?.[1]?.length ?? 2;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const heading = lines[index]!.match(/^(#+)\s+/);
    if (heading && heading[1]!.length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function seededTodoContract(markdown: string): SeededTodoContract {
  const section = finalVerificationSection(markdown);
  const verification: SeededTodoContract["verification"] = [];
  if (
    /\b(?:bun\s+test|run_tests|vitest|jest|pytest|cargo\s+test|go\s+test|swift\s+test)\b/i.test(
      section,
    )
  ) {
    verification.push("test");
  }
  if (
    /\b(?:tsc\s+--noEmit|typecheck|lint|bun\s+run\s+build|bunx\s+(?:tsc|biome|eslint)|cargo\s+check|swift\s+build)\b/i.test(
      section,
    )
  ) {
    verification.push("quality");
  }
  if (/\b(?:smoke(?:\s+test|\s+run)?|launch|start(?:s|ed)?\s+cleanly)\b/i.test(section)) {
    verification.push("launch");
  }
  if (
    /\b(?:playwright|cypress|browser|render(?:ed|ing)?|visual|user interface|web ?page|frontend|screen|dialog|modal|layout)\b/i.test(
      markdown,
    )
  ) {
    verification.push("render");
  }
  return { expectedFiles: explicitPlanFiles(markdown), verification };
}

function todoPathAnchors(content: string): string[] {
  const anchors = new Set<string>();
  for (const match of content.matchAll(/`([^`]+)`/g)) {
    const path = cleanInline(match[1]!);
    if (looksLikeProjectPath(path)) anchors.add(path);
  }
  for (const match of content.matchAll(/\(([^()]+)\)/g)) {
    const path = cleanInline(match[1]!);
    if (looksLikeProjectPath(path)) anchors.add(path);
  }
  return [...anchors];
}

function activityText(tool: string, args: unknown, diffPath?: string): string {
  const record = (args ?? {}) as Record<string, unknown>;
  return [tool, record.path, record.cwd, record.command, diffPath]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .replaceAll("\\", "/");
}

/** Find a later, explicitly anchored todo whose named path is present in successful tool
 * activity. A full verification command may also enter a later verification-labelled step.
 * This reports a phase boundary; it never claims that the preceding task is complete. */
export function observedTodoPhaseTransition(input: {
  todos: TodoItem[];
  tool: string;
  args: unknown;
  diffPath?: string;
  fullVerification?: boolean;
}): { from: number; to: number } | null {
  const from = input.todos.findIndex((todo) => todo.status === "in_progress");
  if (from < 0) return null;
  const activity = activityText(input.tool, input.args, input.diffPath);
  for (let to = from + 1; to < input.todos.length; to++) {
    const todo = input.todos[to]!;
    if (todo.status === "completed") continue;
    // Activity is not evidence that the tracker skipped several pending phases. In particular,
    // a full test run is common inside an early TDD loop and must not jump straight from
    // scaffolding to the final verification step.
    const interveningComplete = input.todos
      .slice(from + 1, to)
      .every((intervening) => intervening.status === "completed");
    if (!interveningComplete) continue;
    const anchors = todoPathAnchors(todo.content);
    if (
      anchors.some((anchor) => {
        const stem = anchor.replace(/\.[^/.]+$/, "");
        return (
          activity.includes(anchor) ||
          (stem.length > 3 && activity.includes(stem)) ||
          (anchor.includes("/") && activity.includes(basename(anchor)))
        );
      })
    ) {
      return { from, to };
    }
    if (
      input.fullVerification &&
      /\b(?:verification|verify|test suite|quality gate|build gate)\b/i.test(todo.content)
    ) {
      return { from, to };
    }
  }
  return null;
}

function normalizedTodo(content: string): string {
  return content
    .toLowerCase()
    .replace(/[`*_—–-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function todoTransitionSatisfied(
  priorTodos: TodoItem[],
  targetIndex: number,
  updatedTodos: TodoItem[],
): boolean {
  const target = priorTodos[targetIndex];
  if (!target) return true;
  const priorActive = priorTodos.findIndex((todo) => todo.status === "in_progress");
  const updatedActive = updatedTodos.findIndex((todo) => todo.status === "in_progress");
  const priorCompleted = priorTodos.filter((todo) => todo.status === "completed").length;
  const updatedCompleted = updatedTodos.filter((todo) => todo.status === "completed").length;
  // The model may legitimately reconcile to a different forward step than the activity heuristic
  // inferred. Accept that monotonic correction instead of forcing the guessed target.
  if (
    priorActive >= 0 &&
    updatedActive > priorActive &&
    (updatedCompleted > priorCompleted || updatedTodos[priorActive]?.status !== "in_progress")
  ) {
    return true;
  }
  const normalized = normalizedTodo(target.content);
  const updated = updatedTodos.find((todo) => normalizedTodo(todo.content) === normalized);
  if (updated) return updated.status !== "pending";
  return updatedActive >= targetIndex || updatedCompleted >= targetIndex;
}

export function missingVerificationEvidence(
  requirements: SeededTodoContract["verification"],
  results: VerificationResult[],
): SeededTodoContract["verification"] {
  return requirements.filter((requirement) => {
    if (requirement === "test") {
      return !results.some(
        (result) => result.ok && result.evidence === "test" && result.scope === "full",
      );
    }
    if (requirement === "quality") {
      return !results.some((result) => result.ok && result.evidence === "quality");
    }
    if (requirement === "render") {
      return !results.some((result) => result.ok && result.evidence === "render");
    }
    return !results.some(
      (result) => result.ok && (result.evidence === "launch" || result.evidence === "render"),
    );
  });
}

export async function missingExpectedFiles(
  expectedFiles: string[],
  projectDir: string,
): Promise<string[]> {
  const missing: string[] = [];
  for (const path of expectedFiles) {
    try {
      if (!(await stat(resolve(projectDir, path))).isFile()) missing.push(path);
    } catch {
      missing.push(path);
    }
  }
  return missing;
}
