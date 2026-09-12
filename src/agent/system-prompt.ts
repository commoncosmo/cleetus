/** Compose the final system prompt from its fragments in a fixed order:
 * instructions → persona → environment → repo map → skills → memories → voice overlay.
 * User instructions come BEFORE the (large) persona so standing preferences get top billing instead
 * of being buried mid-prompt (cf. #142). The tone-only overlay is last so smaller local models do
 * not lose it behind a large repository map or memory block. Empty fragments are dropped, so a
 * `neutral` personality, a disabled repo map, no skills, etc. yield a prompt byte-identical to
 * omitting them. */
export function buildSystemPrompt(parts: {
  personaPrompt: string;
  overlay: string;
  environment: string;
  instructions: string;
  repoMap: string;
  skills: string;
  memories: string;
}): string {
  return [
    parts.instructions,
    parts.personaPrompt,
    parts.environment,
    parts.repoMap,
    parts.skills,
    parts.memories,
    parts.overlay,
  ]
    .filter(Boolean)
    .join("\n\n");
}
