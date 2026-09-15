import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResizeConfig } from "../config/resize";
import type { VisionConfig } from "../config/vision";
import type { ImageRef } from "../providers/types";
import { privateDirectory, privateFile, writePrivateFile } from "../security/private-state";
import { looksLikeHeic, transcodeHeicToJpeg } from "./heic";
import { readImageDimensions } from "./image-dimensions";
import { resizeImage } from "./resize";

export const SUPPORTED_IMAGE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** Detect a supported image MIME from a buffer's magic bytes, or null. Extension is never trusted. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? "bin";
}

export async function storeImage(
  bytes: Buffer,
  cfg: VisionConfig,
  storeDir: string,
  resize: ResizeConfig,
  resizer: typeof resizeImage = resizeImage,
): Promise<{ ref?: ImageRef; error?: string; warning?: string }> {
  const mime = sniffImageMime(bytes);
  if (!mime) return { error: "not a supported image (png, jpeg, gif, or webp)" };
  // Hard cap is checked on the ORIGINAL bytes — reject absurd input before attempting a decode.
  if (bytes.length > cfg.maxBytesHard) {
    return { error: `image too large (${bytes.length} bytes > ${cfg.maxBytesHard} hard cap)` };
  }

  let data = bytes;
  if (resize.enabled) {
    const dims = readImageDimensions(data, mime);
    const overDim = dims != null && Math.max(dims.width, dims.height) > resize.maxDimension;
    // Advisory trigger: resize is dimension-based, so bytes only shrink as a side effect of a
    // dimension reduction. An over-bytes/within-cap image still gets offered to the resizer —
    // resizeImage's never-enlarge guard reads the header, sees it's already within
    // `maxDimension`, and returns it unchanged before spawning sips/jimp, so this is cheap, not
    // wasted. The real OOM risk (and the only thing the warning below cares about) is pixel
    // count, not byte size — a dimension-safe image is never at OOM risk no matter its byte size.
    const overBytes = data.length > cfg.maxBytesSoft;
    if (overDim || overBytes) {
      const r = await resizer(data, mime, resize.maxDimension);
      if (r.bytes) data = r.bytes; // r.error → keep original (graceful passthrough)
    }
  }

  // Warn only when the FINAL image is still over the DIMENSION cap — a genuinely high-resolution
  // image the resizer couldn't shrink (disabled, errored, or unavailable). Byte size alone never
  // warns: it isn't what drives the OOM risk.
  const finalDims = readImageDimensions(data, mime);
  const warning =
    finalDims != null && Math.max(finalDims.width, finalDims.height) > resize.maxDimension
      ? `image is still ${finalDims.width}x${finalDims.height} (> ${resize.maxDimension}px cap) and could not be downscaled; sending at full size (may fail on low-memory local vision models)`
      : undefined;
  const sha256 = createHash("sha256").update(data).digest("hex");
  privateDirectory(storeDir);
  const path = join(storeDir, `${sha256}.${extForMime(mime)}`);
  if (!existsSync(path)) writePrivateFile(path, data);
  else privateFile(path);
  return { ref: { mime, path, sha256 }, warning };
}

export async function resolveAttachmentPaths(
  paths: string[],
  cfg: VisionConfig,
  storeDir: string,
  resize: ResizeConfig,
): Promise<{ refs: ImageRef[]; errors: string[]; warnings: string[] }> {
  const refs: ImageRef[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (refs.length >= cfg.maxPerTurn) {
      errors.push(`too many images: at most ${cfg.maxPerTurn} per message`);
      break;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(p);
    } catch {
      errors.push(`cannot read image: ${p}`);
      continue;
    }
    if (looksLikeHeic(bytes)) {
      const t = transcodeHeicToJpeg(bytes);
      if (t.error) {
        errors.push(`${p}: ${t.error}`);
        continue;
      }
      bytes = t.bytes as Buffer;
    }
    const { ref, error, warning } = await storeImage(bytes, cfg, storeDir, resize);
    if (error) {
      errors.push(`${p}: ${error}`);
      continue;
    }
    if (warning) warnings.push(`${p}: ${warning}`);
    if (ref && !seen.has(ref.sha256)) {
      seen.add(ref.sha256);
      refs.push(ref);
    }
  }
  return { refs, errors, warnings };
}

export function stageImages(current: ImageRef[], resolved: { refs: ImageRef[] }): ImageRef[] {
  const out = [...current];
  const seen = new Set(current.map((r) => r.sha256));
  for (const r of resolved.refs) {
    if (!seen.has(r.sha256)) {
      seen.add(r.sha256);
      out.push(r);
    }
  }
  return out;
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|heic|heif)$/i;

/** True when a path is "rooted" (absolute, home, or explicitly relative) — a strong signal the user
 *  meant it as a real file, not incidental prose. */
export function isRootedPath(p: string): boolean {
  return /^(?:\/|~|\.\.?\/)/.test(p);
}

/** Split a prompt into `@`-sigil image tokens (force-attach) and bare image-extension tokens
 *  (auto-detect). Pure — the caller validates each by attempting to read it.
 *
 *  Splits on unescaped whitespace, then unescapes backslash-escaped whitespace within each
 *  token — this lets drag-dropped/terminal-escaped paths with spaces (e.g.
 *  `/Users/me/Desktop/Some\ Folder/IMG.JPG`) survive as one token without doing any
 *  quote-parsing that could swallow prose apostrophes (e.g. "What's"/"don't"). */
export function extractImageCandidates(text: string): {
  sigilPaths: string[];
  autoPaths: string[];
} {
  const sigilPaths: string[] = [];
  const autoPaths: string[] = [];
  for (const raw of text.split(/(?<!\\)\s+/)) {
    const token = raw.replace(/\\(\s)/g, "$1");
    if (token.startsWith("@") && token.length > 1) {
      const p = token.slice(1);
      if (IMAGE_EXT_RE.test(p)) sigilPaths.push(p);
    } else if (IMAGE_EXT_RE.test(token)) {
      autoPaths.push(token);
    }
  }
  return { sigilPaths, autoPaths };
}

/** Split a command argument string into path tokens like a POSIX shell: unquoted whitespace
 *  separates; single/double quotes group; a backslash escapes the next char. Quotes and escaping
 *  backslashes are stripped from the returned tokens, so a path containing spaces survives as one. */
export function tokenizePathArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < input.length) {
        current += input[++i] as string;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i] as string;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}
