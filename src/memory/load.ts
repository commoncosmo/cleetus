import { MemoryStore } from "./store";

export interface LoadMemoriesOptions {
  globalPath: string;
  projectPath?: string;
}

/** Formatted "## Memories" block for the system prompt; "" when both scopes are empty. */
export function loadMemories(opts: LoadMemoriesOptions): string {
  const global = new MemoryStore(opts.globalPath).list();
  const project = opts.projectPath ? new MemoryStore(opts.projectPath).list() : [];
  if (global.length === 0 && project.length === 0) return "";

  const sections: string[] = [
    "## Memories\n\nThese are durable facts you were asked to remember across sessions. Treat them as " +
      "authoritative context. When the user asks what you remember, recite the items below — this " +
      "is not stored in any searchable index; it is already provided here.",
  ];
  if (global.length > 0) {
    sections.push(`Things to remember (global):\n${global.map((m) => `- ${m}`).join("\n")}`);
  }
  if (project.length > 0) {
    sections.push(`Things to remember (this project):\n${project.map((m) => `- ${m}`).join("\n")}`);
  }
  return sections.join("\n\n");
}
