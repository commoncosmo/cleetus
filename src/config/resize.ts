import type { RawResize } from "./schema";

export interface ResizeConfig {
  /** When false, storeImage stores the image full-size and warns (pre-feature behavior). */
  enabled: boolean;
  /** Longest-side cap in pixels. Images with max(width,height) above this are downscaled. */
  maxDimension: number;
}

export const DEFAULT_RESIZE: ResizeConfig = {
  enabled: true,
  maxDimension: 1568,
};

/** Resolve resize settings with project > global > default precedence. Pure. */
export function resolveResize(global?: RawResize, project?: RawResize): ResizeConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? DEFAULT_RESIZE.enabled,
    maxDimension: project?.max_dimension ?? global?.max_dimension ?? DEFAULT_RESIZE.maxDimension,
  };
}
