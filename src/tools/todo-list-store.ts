import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TodoItem, TodoStatus } from "./types";

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_NAME = 64;

/** A list name is safe to use as a filename: lowercase slug, no slashes/dots/`..`. */
export function isValidListName(name: unknown): name is string {
  return typeof name === "string" && name.length <= MAX_NAME && NAME_RE.test(name);
}

const FILE_MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

/** `TodoItem[]` → file text: a `# <name>` title plus `- [mark] content` lines. */
export function serializeList(name: string, todos: TodoItem[]): string {
  const lines = todos.map((t) => `- ${FILE_MARK[t.status]} ${t.content.replace(/\s*\n\s*/g, " ")}`);
  return `${[`# ${name}`, ...lines].join("\n")}\n`;
}

/** Parse file text → `TodoItem[]`, tolerantly (ignores the title and any non-item line). */
export function parseList(text: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^- \[([ x~])\] (.+)$/);
    if (!m) continue;
    const content = m[2]!.trim();
    if (content.length === 0) continue;
    const status: TodoStatus =
      m[1] === "x" ? "completed" : m[1] === "~" ? "in_progress" : "pending";
    items.push({ content, status });
  }
  return items;
}

export class TodoListStore {
  constructor(private readonly dir: string) {}

  private path(name: string): string {
    if (!isValidListName(name)) throw new Error(`invalid list name: ${String(name)}`);
    return join(this.dir, `${name}.md`);
  }

  read(name: string): TodoItem[] {
    const p = this.path(name);
    if (!existsSync(p)) return [];
    try {
      return parseList(readFileSync(p, "utf8"));
    } catch {
      return [];
    }
  }

  write(name: string, todos: TodoItem[]): void {
    const p = this.path(name);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(p, serializeList(name, todos));
  }

  delete(name: string): boolean {
    const p = this.path(name);
    if (!existsSync(p)) return false;
    rmSync(p);
    return true;
  }

  listNames(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((n) => isValidListName(n))
      .sort();
  }
}
