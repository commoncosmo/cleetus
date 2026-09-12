import type { Skill } from "./types";

/** Assemble the skill's playbook body plus (for directory skills) the progressive-disclosure
 *  block naming the base dir and bundled files. No user-args trailer. Shared by composeSkillTurn
 *  and renderSkillReminder so the directory block is defined once (DRY). */
export function composeSkillBody(skill: Skill): string {
  let body = skill.body.trim();
  if (skill.baseDir) {
    body += `\n\nBase directory for this skill: ${skill.baseDir}`;
    if (skill.resources && skill.resources.length > 0) {
      body += "\nBundled files you can read with read_file as this skill's instructions direct:";
      for (const r of skill.resources) body += `\n- ${r}`;
    }
  }
  return body;
}

/** Build the turn text seeded when a skill is invoked via `/skill <name> [args]`: the command as
 *  typed, then — inside a `<system-reminder>` so the transcript shows only the user's words (#316)
 *  — the body and the user's free-form trailing arguments (or a no-args note). */
export function composeSkillTurn(skill: Skill, args: string): string {
  const trimmed = args.trim();
  const visible = trimmed ? `/skill ${skill.name} ${trimmed}` : `/skill ${skill.name}`;
  const trailer = trimmed
    ? `User request / arguments: ${trimmed}`
    : "(No additional arguments were provided.)";
  return `${visible}\n\n<system-reminder>\nThe "${skill.name}" skill was invoked explicitly. Follow its playbook:\n\n${composeSkillBody(skill)}\n\n${trailer}\n</system-reminder>`;
}

/** Advisory reminder injected when a skill auto-triggers on a turn. Wraps the skill body in a
 *  system-reminder alongside the user's own message. No args trailer (auto-invocation has none). */
export function renderSkillReminder(skill: Skill): string {
  return `<system-reminder>\nThe "${skill.name}" skill applies to this request. Follow its guidance:\n\n${composeSkillBody(skill)}\n</system-reminder>`;
}

/** Remove every injected <system-reminder>…</system-reminder> block (the inverse of
 *  renderSkillReminder), recovering the raw text. Collapses the surrounding whitespace the
 *  removed block leaves behind so no dangling blank lines remain. Pure. */
export function stripSystemReminders(text: string): string {
  return text.replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "\n").trim();
}
