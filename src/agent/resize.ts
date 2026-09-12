import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readImageDimensions } from "./image-dimensions";

export interface ResizeDeps {
  sipsRunner?: (inPath: string, outPath: string, cap: number) => boolean;
  jimpResize?: (bytes: Buffer, mime: string, cap: number) => Promise<Buffer>;
  platform?: NodeJS.Platform;
}

/** Temp-file extension by MIME (cosmetic; sips encodes from source content). Kept local so this
 *  module has no dependency on attachments.ts (which imports resizeImage — avoids an import cycle). */
const TMP_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function defaultSipsRunner(inPath: string, outPath: string, cap: number): boolean {
  try {
    // -Z fits the image within `cap` on its longest side, preserving aspect. NOTE: sips itself
    // will happily scale a smaller image *up* to `cap` — the never-enlarge guarantee here comes
    // from the dimension check in resizeImage(), not from sips's own behavior.
    execFileSync("sips", ["-Z", String(cap), inPath, "--out", outPath]);
  } catch {
    return false;
  }
  return existsSync(outPath);
}

// jimp@1.6.1's default formats are bmp/gif/jpeg/png/tiff — no webp encode/decode. A webp buffer
// on a non-darwin platform (or after a sips failure) will fail Jimp.read() and resizeImage()
// gracefully returns { error }; it never throws.
type JimpMime =
  | "image/bmp"
  | "image/tiff"
  | "image/x-ms-bmp"
  | "image/gif"
  | "image/jpeg"
  | "image/png";

async function defaultJimpResize(bytes: Buffer, mime: string, cap: number): Promise<Buffer> {
  const { Jimp } = await import("jimp");
  const image = await Jimp.read(bytes);
  // scaleToFit (jimp v1, @jimp/plugin-resize) also scales up when the image is already smaller
  // than cap×cap; resizeImage() only reaches this path once it has confirmed a resize is needed.
  image.scaleToFit({ w: cap, h: cap });
  return Buffer.from(await image.getBuffer(mime as JimpMime));
}

/** Downscale so max(width,height) <= cap. sips-first on darwin, jimp fallback, else { error }.
 *  Deps are injectable so both branches are testable on any OS (mirrors src/agent/heic.ts). */
export async function resizeImage(
  bytes: Buffer,
  mime: string,
  cap: number,
  deps: ResizeDeps = {},
): Promise<{ bytes?: Buffer; error?: string }> {
  const platform = deps.platform ?? process.platform;
  const sipsRunner = deps.sipsRunner ?? defaultSipsRunner;
  const jimpResize = deps.jimpResize ?? defaultJimpResize;

  // Never enlarge: if the source is already within cap on its longest side, skip resizing
  // entirely (neither sips -Z nor jimp's scaleToFit clamp against upscaling on their own).
  // readImageDimensions only parses the mimes attachments.ts's sniffer recognizes (png/jpeg/gif/
  // webp) — an unrecognized/unparseable mime returns null and we fall through to the resizer.
  const dims = readImageDimensions(bytes, mime);
  if (dims && Math.max(dims.width, dims.height) <= cap) {
    return { bytes };
  }

  if (platform === "darwin") {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const ext = TMP_EXT[mime] ?? "img";
    const inPath = join(tmpdir(), `cleetus-resize-${hash}.${ext}`);
    const outPath = join(tmpdir(), `cleetus-resize-${hash}.out.${ext}`);
    try {
      try {
        writeFileSync(inPath, bytes);
        if (sipsRunner(inPath, outPath, cap)) {
          try {
            return { bytes: readFileSync(outPath) };
          } catch {
            // fall through to jimp
          }
        }
      } catch {
        // write or sipsRunner itself threw (ENOSPC/EACCES/missing tmpdir/etc.) — fall through to jimp
      }
    } finally {
      try {
        rmSync(inPath, { force: true });
      } catch {}
      try {
        rmSync(outPath, { force: true });
      } catch {}
    }
  }

  // Non-darwin, or sips unavailable/failed → jimp (pure JS, cross-platform).
  try {
    return { bytes: await jimpResize(bytes, mime, cap) };
  } catch {
    return { error: "could not resize image (no working image resizer)" };
  }
}
