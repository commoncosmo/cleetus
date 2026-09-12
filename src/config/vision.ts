import type { RawVision } from "./schema";

export interface VisionConfig {
  /** Treat unknown/unsupported capability as supported (for un-probeable vision models). */
  assumeSupported: boolean;
  /** Model-name substrings force-treated as vision-capable. */
  models: string[];
  /** Max images accepted per turn. */
  maxPerTurn: number;
  /** Warn above this per-image byte size (still sent). */
  maxBytesSoft: number;
  /** Block above this per-image byte size. */
  maxBytesHard: number;
}

export const DEFAULT_VISION: VisionConfig = {
  assumeSupported: false,
  models: [],
  maxPerTurn: 8,
  maxBytesSoft: 5 * 1024 * 1024,
  maxBytesHard: 20 * 1024 * 1024,
};

/** Resolve vision settings with project > global > default precedence. Pure. */
export function resolveVision(global?: RawVision, project?: RawVision): VisionConfig {
  return {
    assumeSupported:
      project?.assume_supported ?? global?.assume_supported ?? DEFAULT_VISION.assumeSupported,
    models: project?.models ?? global?.models ?? DEFAULT_VISION.models,
    maxPerTurn: project?.max_per_turn ?? global?.max_per_turn ?? DEFAULT_VISION.maxPerTurn,
    maxBytesSoft: project?.max_bytes_soft ?? global?.max_bytes_soft ?? DEFAULT_VISION.maxBytesSoft,
    maxBytesHard: project?.max_bytes_hard ?? global?.max_bytes_hard ?? DEFAULT_VISION.maxBytesHard,
  };
}
