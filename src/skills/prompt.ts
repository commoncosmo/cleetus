import type { Skill } from "./types";

/** A compact system-prompt fragment advertising MANUAL skills for the model to suggest via
 *  `/skill`. Auto-trigger skills (those with a `trigger`) self-inject and are omitted here so
 *  the model doesn't redundantly nudge the user to run them. Empty when there are no manual
 *  skills, so it drops out of the prompt cleanly (see buildSystemPrompt). */
export function renderSkillsHint(skills: Skill[]): string {
  const manual = skills.filter((s) => !s.trigger && s.name !== "workflow-creator");
  if (manual.length === 0) return "";
  return [
    "Available skills (run with /skill <name>):",
    ...manual.map((s) => `- ${s.name} — ${s.description}`),
    "When the user's request matches a skill, suggest they run the matching `/skill <name>` command. Do not run a skill yourself.",
  ].join("\n");
}
