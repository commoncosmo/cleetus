import { parse as parseYaml } from "yaml";
import { withLearnedIntentAnchor } from "./learned-anchor";
import type { LearnedSkillMetadata, Skill, SkillScope, SkillTrigger } from "./types";

/** Normalize a YAML scalar-or-list value to a trimmed, non-empty string list. Anything else → []. */
function toStringList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim());
  }
  return [];
}

/**
 * Parse one user skill markdown file into name/description/body. Tolerant:
 *  - no frontmatter → name from filename, description "(user skill)", body = whole file;
 *  - frontmatter present but missing/empty `name` → filename-derived; missing/empty or
 *    non-string `description` → "(user skill)";
 *  - MALFORMED frontmatter YAML → treated as no frontmatter (whole file as body), silently;
 *  - empty body (after trim) → null (caller skips it).
 * Never throws. `filename` may be a basename or a full path; only the final path segment
 * (minus any `.md` extension) is used as the fallback name. The returned body is trimmed.
 */
export function parseSkillFile(content: string, filename: string): Omit<Skill, "source"> | null {
  const text = content.replace(/\r\n/g, "\n");
  let name = filename.replace(/.*[\\/]/, "").replace(/\.md$/i, "");
  let description = "(user skill)";
  let body = text;
  let trigger: SkillTrigger | undefined;
  let scope: SkillScope | undefined;
  let learned: LearnedSkillMetadata | undefined;
  let capability: string | undefined;
  let compose = false;

  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    let parsed: unknown;
    let malformed = false;
    try {
      parsed = parseYaml(fm[1]!);
    } catch {
      malformed = true; // treat as no frontmatter — keep the whole file as the body
    }
    if (!malformed) {
      // A well-formed (even empty) frontmatter block is stripped from the body.
      body = text.slice(fm[0].length);
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        if (typeof rec.name === "string" && rec.name.trim()) name = rec.name.trim();
        if (typeof rec.description === "string" && rec.description.trim()) {
          description = rec.description.trim();
        }
        if (rec.trigger && typeof rec.trigger === "object" && !Array.isArray(rec.trigger)) {
          const t = rec.trigger as Record<string, unknown>;
          const when = toStringList(t.when);
          const match = toStringList(t.match);
          if (when.length > 0 || match.length > 0) trigger = { when, match };
        }
        if (typeof rec.scope === "string") {
          const s = rec.scope.trim().toLowerCase();
          if (s === "decompose" || s === "execute" || s === "both") scope = s;
        }
        const metadata =
          rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata)
            ? (rec.metadata as Record<string, unknown>)
            : undefined;
        if (
          typeof metadata?.["cleetus-capability"] === "string" &&
          metadata["cleetus-capability"].trim()
        ) {
          capability = metadata["cleetus-capability"].trim().toLowerCase();
        }
        if (typeof metadata?.["cleetus-compose"] === "string") {
          compose = metadata["cleetus-compose"].trim().toLowerCase() === "true";
        }
        const learnedValue =
          metadata?.learned &&
          typeof metadata.learned === "object" &&
          !Array.isArray(metadata.learned)
            ? (metadata.learned as Record<string, unknown>)
            : undefined;
        if (learnedValue) {
          const sourceSessions = [
            ...toStringList(learnedValue.source_sessions),
            ...toStringList(learnedValue.source_session),
          ].filter((value, index, all) => all.indexOf(value) === index);
          const createdAt =
            typeof learnedValue.created_at === "string" && learnedValue.created_at.trim()
              ? learnedValue.created_at.trim()
              : undefined;
          const updatedAt =
            typeof learnedValue.updated_at === "string" && learnedValue.updated_at.trim()
              ? learnedValue.updated_at.trim()
              : undefined;
          const parsedRevision =
            typeof learnedValue.revision === "number" && Number.isFinite(learnedValue.revision)
              ? Math.max(1, Math.floor(learnedValue.revision))
              : 1;
          if (sourceSessions.length > 0) {
            learned = {
              sourceSessions,
              createdAt,
              updatedAt,
              revision: parsedRevision,
            };
          }
        }
      }
    }
  }

  if (!body.trim()) return null;
  if (learned && trigger?.match.length) {
    trigger = {
      ...trigger,
      match: withLearnedIntentAnchor({
        triggers: trigger.match,
        name,
        description,
      }),
    };
  }
  return {
    name,
    description,
    body: body.trim(),
    ...(trigger ? { trigger } : {}),
    ...(scope ? { scope } : {}),
    ...(learned ? { learned } : {}),
    ...(capability ? { capability } : {}),
    ...(compose ? { compose: true } : {}),
  };
}
