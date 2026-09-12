import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEIC_BRAND_RE = /^(?:heic|heix|heif|hevc|hevx|mif1|msf1|heim|heis|hevm|hevs)$/;

/** True when the buffer is ISO-BMFF HEIF/HEIC (ftyp box with a HEIC/HEIF brand). Magic-byte based. */
export function looksLikeHeic(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  if (bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  const brand = bytes.subarray(8, 12).toString("ascii");
  return HEIC_BRAND_RE.test(brand);
}

function defaultRunner(inPath: string, outPath: string): boolean {
  try {
    execFileSync("sips", ["-s", "format", "jpeg", inPath, "--out", outPath]);
  } catch {
    return false;
  }
  return existsSync(outPath);
}

/** Transcode HEIC/HEIF bytes to JPEG. macOS-only via `sips`; `runner` and `platform` are injectable
 *  so the success and non-macOS paths are both testable on any OS (a hard `process.platform` gate
 *  would otherwise make the success path unreachable off darwin — e.g. Linux CI).
 *  Returns {bytes} on success or {error} (non-macOS, sips missing, or failure) with a friendly message. */
export function transcodeHeicToJpeg(
  bytes: Buffer,
  runner: (inPath: string, outPath: string) => boolean = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): { bytes?: Buffer; error?: string } {
  if (platform !== "darwin") {
    return {
      error:
        "HEIC/HEIF images aren't directly supported; convert to JPEG or PNG first (auto-conversion needs macOS `sips`).",
    };
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const inPath = join(tmpdir(), `cleetus-heic-${hash}.heic`);
  const outPath = join(tmpdir(), `cleetus-heic-${hash}.jpg`);
  try {
    writeFileSync(inPath, bytes);
    const ok = runner(inPath, outPath);
    if (!ok) {
      return { error: "HEIC/HEIF conversion failed; convert to JPEG or PNG first." };
    }
    try {
      return { bytes: readFileSync(outPath) };
    } catch {
      return { error: "HEIC/HEIF conversion failed; convert to JPEG or PNG first." };
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
