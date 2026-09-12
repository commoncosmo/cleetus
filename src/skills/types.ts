/** Where a skill came from. Built-ins are embedded in the binary; project/global
 *  are user-authored markdown discovered from the filesystem. */
export type SkillSource = "built-in" | "project" | "global";

/** Declares when a skill auto-invokes. A skill triggers when ANY listed condition matches:
 *  a named predicate in `when` returns true, or a `match` substring is present in the user's
 *  message (case-insensitive). Both lists are normalized (scalar → 1-element list). */
export interface SkillTrigger {
  when: string[];
  match: string[];
}

/** Provenance written by `/learn`. Its presence distinguishes a Cleetus-managed learned
 * playbook from a user-authored skill that must never be revised automatically. */
export interface LearnedSkillMetadata {
  sourceSessions: string[];
  createdAt?: string;
  updatedAt?: string;
  revision: number;
}

/** Which orchestration phase a skill participates in. Absent ⇒ treated as "both".
 *  Gates ONLY the orchestration decompose/execute resolvers — inline auto-invocation ignores it. */
export type SkillScope = "decompose" | "execute" | "both";

export interface Skill {
  name: string;
  description: string;
  source: SkillSource;
  body: string;
  /** Absolute entrypoint path for discovered user skills. Undefined for embedded built-ins. */
  filePath?: string;
  /** Present only for playbooks created by `/learn`. */
  learned?: LearnedSkillMetadata;
  /** Absolute path to the skill's directory. Set ONLY for directory (SKILL.md) skills;
   *  undefined for flat *.md skills and embedded built-ins. Drives progressive disclosure. */
  baseDir?: string;
  /** Bundled files under `baseDir`, relative to it, excluding SKILL.md; sorted. Undefined
   *  for flat/built-in skills. Surfaced (names only) in the composed turn. */
  resources?: string[];
  /** Present only when the frontmatter declared a non-empty `trigger` block. Truthy ⇔ the
   *  skill can auto-invoke. Absent ⇒ manual (`/skill`) only. */
  trigger?: SkillTrigger;
  /** Orchestration phase gate (see SkillScope). Absent ⇒ both. Set from a `scope:` frontmatter
   *  scalar; an unrecognized value is dropped (→ undefined → both). */
  scope?: SkillScope;
  /** Optional Cleetus routing identity read from the Agent Skills-compatible
   *  `metadata.cleetus-capability` string. Matching auto-triggered skills in the same
   *  capability compete instead of all being injected. */
  capability?: string;
  /** Opts this skill into intentional composition with other matching skills in its capability.
   *  Read from the string-valued `metadata.cleetus-compose` extension. */
  compose?: boolean;
}
