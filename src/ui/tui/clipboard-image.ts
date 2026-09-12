import { execFileSync } from "node:child_process";

function defaultRunner(cmd: string, args: string[]): Buffer | null {
  try {
    const out = execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

const IMAGE_EXT_RE = /\.(heic|heif|png|jpe?g|gif|webp|tiff?|bmp)$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;

/** POSIX path of a file reference on the clipboard, or null when no real file is present. Gated on
 *  the pasteboard actually advertising a file-url (`furl`) type: `the clipboard as «class furl»` will
 *  otherwise coerce plain TEXT into a bogus file URL (verified — copied text round-trips as a path),
 *  so the info check is what keeps text from masquerading as a file. */
function clipboardFilePath(runner: (cmd: string, args: string[]) => Buffer | null): string | null {
  const info = runner("osascript", ["-e", "clipboard info"]);
  if (!info || !/furl/i.test(info.toString())) return null;
  const path = runner("osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"]);
  const trimmed = path?.toString().trim();
  return trimmed ? trimmed : null;
}

/** Ready-to-paste `/image <path>` command, quoting paths with whitespace so the tokenizer keeps
 *  them whole (many photo libraries live under paths like ".../Sample Photos/IMG.heic"). */
function imageCommandFor(path: string): string {
  return `/image ${/\s/.test(path) ? `"${path}"` : path}`;
}

/** Grab a PNG from the OS clipboard. macOS-only: shells out to `pngpaste -`, which reads whatever
 *  image is on the pasteboard and emits PNG on stdout. Returns a friendly, actionable error when
 *  the platform is unsupported, `pngpaste` isn't installed, or no image comes back — including a
 *  HEIC-specific nudge, since some macOS/pngpaste builds can't rasterize HEIC from the clipboard
 *  even though the by-path attach flow transcodes it. `runner` is injectable for tests. */
export function grabClipboardImage(
  runner: (cmd: string, args: string[]) => Buffer | null = (c, a) => defaultRunner(c, a),
): { bytes?: Buffer; error?: string } {
  if (process.platform !== "darwin") {
    return {
      error: "clipboard image capture is only supported on macOS — use /image <path> instead",
    };
  }
  // Distinguish "not installed" from "installed but produced no image": both make the grab return
  // null, but only the former is fixable with an install.
  const installed = runner("which", ["pngpaste"]) !== null;
  if (!installed) {
    return {
      error:
        "clipboard image capture needs pngpaste — install it with `brew install pngpaste`, or use /image <path>",
    };
  }
  const png = runner("pngpaste", ["-"]);
  if (png) return { bytes: png };
  // pngpaste found nothing. If a file is on the clipboard, point at the by-path flow (which reads
  // the file directly and transcodes HEIC→JPEG), calling out HEIC explicitly since that's the
  // format pngpaste most often can't convert.
  const filePath = clipboardFilePath(runner);
  if (filePath && HEIC_EXT_RE.test(filePath)) {
    return {
      error: `pngpaste can't read HEIC from the clipboard — reference the file by path instead: ${imageCommandFor(filePath)}`,
    };
  }
  if (filePath && IMAGE_EXT_RE.test(filePath)) {
    return {
      error: `pngpaste couldn't read that image from the clipboard — reference the file by path instead: ${imageCommandFor(filePath)}`,
    };
  }
  return { error: "no image found on the clipboard — copy an image first, or use /image <path>" };
}
