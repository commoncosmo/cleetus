import type { RawAttachments } from "./schema";

export interface AttachmentsConfig {
  /** Run an orphan-only attachment GC sweep once at session start. */
  gcOnStartup: boolean;
  /** Never collect attachments modified within this many hours (in-flight / concurrency guard). */
  gcMinAgeHours: number;
}

export const DEFAULT_ATTACHMENTS: AttachmentsConfig = {
  gcOnStartup: false,
  gcMinAgeHours: 24,
};

/** Resolve attachment settings with project > global > default precedence. Pure. */
export function resolveAttachments(
  global?: RawAttachments,
  project?: RawAttachments,
): AttachmentsConfig {
  return {
    gcOnStartup: project?.gc_on_startup ?? global?.gc_on_startup ?? DEFAULT_ATTACHMENTS.gcOnStartup,
    gcMinAgeHours:
      project?.gc_min_age_hours ?? global?.gc_min_age_hours ?? DEFAULT_ATTACHMENTS.gcMinAgeHours,
  };
}
