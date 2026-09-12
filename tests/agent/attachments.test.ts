import { describe, expect, it, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractImageCandidates,
  isRootedPath,
  resolveAttachmentPaths,
  sniffImageMime,
  stageImages,
  storeImage,
  tokenizePathArgs,
} from "../../src/agent/attachments";
import type { ResizeConfig } from "../../src/config/resize";
import { DEFAULT_VISION, type VisionConfig } from "../../src/config/vision";

const NO_RESIZE: ResizeConfig = { enabled: false, maxDimension: 1568 };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAQB5xW1xAAAAAElFTkSuQmCC",
  "base64",
);

test("sniffImageMime detects supported formats by signature", () => {
  expect(sniffImageMime(PNG)).toBe("image/png");
  expect(sniffImageMime(JPEG)).toBe("image/jpeg");
  expect(sniffImageMime(GIF)).toBe("image/gif");
  expect(sniffImageMime(WEBP)).toBe("image/webp");
});

test("sniffImageMime rejects non-images and truncated buffers", () => {
  expect(sniffImageMime(Buffer.from("not an image"))).toBeNull();
  expect(sniffImageMime(Buffer.from([0x89]))).toBeNull();
});

test("storeImage writes a hashed copy and returns an ImageRef", async () => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  const r = await storeImage(REAL_PNG, DEFAULT_VISION, dir, NO_RESIZE);
  expect(r.error).toBeUndefined();
  expect(r.ref?.mime).toBe("image/png");
  expect(r.ref?.path.endsWith(".png")).toBe(true);
  expect(existsSync(r.ref!.path)).toBe(true);
  expect(readFileSync(r.ref!.path).equals(REAL_PNG)).toBe(true);
  // Idempotent: same content → same path, written once.
  const r2 = await storeImage(REAL_PNG, DEFAULT_VISION, dir, NO_RESIZE);
  expect(r2.ref?.path).toBe(r.ref?.path);
});

test("storeImage rejects a non-image", async () => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  const r = await storeImage(Buffer.from("nope"), DEFAULT_VISION, dir, NO_RESIZE);
  expect(r.ref).toBeUndefined();
  expect(r.error).toContain("not a supported image");
});

test("storeImage blocks above the hard byte cap; a dimension-safe image over the soft cap warns not at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  const hard = await storeImage(REAL_PNG, { ...DEFAULT_VISION, maxBytesHard: 1 }, dir, NO_RESIZE);
  expect(hard.ref).toBeUndefined();
  expect(hard.error).toContain("too large");
  // REAL_PNG is a 1x1 pixel image — dimension-safe. The warning is dimension-based (pixel count
  // drives the OOM risk, not byte size), so an over-soft-byte-cap-but-tiny-dimension image must
  // NOT warn — it genuinely can't OOM a low-memory local model.
  const soft = await storeImage(REAL_PNG, { ...DEFAULT_VISION, maxBytesSoft: 1 }, dir, NO_RESIZE);
  expect(soft.ref).toBeDefined();
  expect(soft.warning).toBeUndefined();
});

test("resolveAttachmentPaths stores, dedupes, and reports a missing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  const a = join(dir, "a.png");
  const b = join(dir, "b.png");
  writeFileSync(a, REAL_PNG);
  writeFileSync(b, REAL_PNG); // identical content → dedupes to one ref
  const store = join(dir, "store");
  const r = await resolveAttachmentPaths(
    [a, b, join(dir, "missing.png")],
    DEFAULT_VISION,
    store,
    NO_RESIZE,
  );
  expect(r.refs).toHaveLength(1);
  expect(r.errors.some((e) => e.includes("missing.png"))).toBe(true);
});

test("resolveAttachmentPaths enforces the per-turn count cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  const paths = ["a", "b", "c"].map((n, i) => {
    const p = join(dir, `${n}.png`);
    // distinct content per file so they don't dedupe (vary a trailing byte)
    writeFileSync(p, Buffer.concat([REAL_PNG, Buffer.from([i])]));
    return p;
  });
  const r = await resolveAttachmentPaths(
    paths,
    { ...DEFAULT_VISION, maxPerTurn: 2 },
    join(dir, "s"),
    NO_RESIZE,
  );
  expect(r.refs).toHaveLength(2);
  expect(r.errors.some((e) => e.includes("at most 2"))).toBe(true);
});

test("stageImages merges and dedupes by sha256, preserving order", () => {
  const a = { mime: "image/png", path: "/x/a.png", sha256: "1" };
  const b = { mime: "image/png", path: "/x/b.png", sha256: "2" };
  expect(stageImages([a], { refs: [b, a] })).toEqual([a, b]);
});

test("extractImageCandidates finds sigil and auto tokens, ignores plain words", () => {
  const r = extractImageCandidates(
    "look at @./shot.png and ./diagram.jpg but not report.md or plain",
  );
  expect(r.sigilPaths).toEqual(["./shot.png"]);
  expect(r.autoPaths).toEqual(["./diagram.jpg"]);
});

test("extractImageCandidates returns empty arrays for text with no image refs", () => {
  const r = extractImageCandidates("just a normal sentence about png files conceptually");
  expect(r.sigilPaths).toEqual([]);
  expect(r.autoPaths).toEqual([]);
});

test("extractImageCandidates unescapes backslash-escaped spaces in auto-detected paths", () => {
  const r = extractImageCandidates("look at /a/Sample\\ Photos/IMG.JPG");
  expect(r.autoPaths).toEqual(["/a/Sample Photos/IMG.JPG"]);
});

test("extractImageCandidates unescapes backslash-escaped spaces in sigil paths", () => {
  const r = extractImageCandidates("@/a/b\\ c.png");
  expect(r.sigilPaths).toEqual(["/a/b c.png"]);
});

test("extractImageCandidates does not let prose apostrophes swallow other tokens", () => {
  const r = extractImageCandidates("What's going on with report.md and shot.png");
  expect(r.autoPaths).toEqual(["shot.png"]);
});

test("tokenizePathArgs splits unquoted whitespace and strips quotes", () => {
  expect(tokenizePathArgs('"/a/b c.png" /d/e.png')).toEqual(["/a/b c.png", "/d/e.png"]);
});

test("tokenizePathArgs unescapes a backslash-escaped space outside quotes", () => {
  expect(tokenizePathArgs("/a/b\\ c.png")).toEqual(["/a/b c.png"]);
});

test("extractImageCandidates detects a .HEIC path as an autoPath", () => {
  const r = extractImageCandidates("check /a/IMG_4157.HEIC please");
  expect(r.autoPaths).toEqual(["/a/IMG_4157.HEIC"]);
});

test("isRootedPath recognizes absolute, home, and explicitly relative paths", () => {
  expect(isRootedPath("/a.png")).toBe(true);
  expect(isRootedPath("~/a.png")).toBe(true);
  expect(isRootedPath("./a.png")).toBe(true);
  expect(isRootedPath("../a.png")).toBe(true);
  expect(isRootedPath("a.png")).toBe(false);
  expect(isRootedPath("foo/bar.png")).toBe(false);
});

/** PNG whose IHDR advertises w×h; `pad` extra trailing bytes inflate the file size. */
function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(24 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const smallCaps: VisionConfig = { ...DEFAULT_VISION, maxBytesSoft: 100, maxBytesHard: 10_000 };
const resizeOn: ResizeConfig = { enabled: true, maxDimension: 1568 };

describe("storeImage resize-on-ingest", () => {
  it("resizes when a dimension exceeds the cap; stores + hashes the resized bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleetus-store-"));
    const caps: number[] = [];
    const resizer = async (_b: Buffer, _m: string, cap: number) => {
      caps.push(cap);
      return { bytes: Buffer.from("RESIZED") };
    };
    const { ref } = await storeImage(png(4032, 3024), smallCaps, dir, resizeOn, resizer);
    expect(caps).toEqual([1568]);
    expect(readFileSync(ref!.path).toString()).toBe("RESIZED");
    expect(ref!.sha256).toBe(createHash("sha256").update(Buffer.from("RESIZED")).digest("hex"));
  });

  it("resizes when bytes exceed the soft cap even if dimensions are small", async () => {
    // This pins storeImage's TRIGGER dispatch only: the byte cap is advisory, so an over-bytes
    // image still gets offered to the resizer. In production, resizeImage's never-enlarge guard
    // reads the header and no-ops (returns the bytes unchanged) once dimensions are already
    // within the cap — the fake resizer here just proves storeImage *offers* the image, not that
    // a real resize happens (it doesn't need to: bytes-only-large images aren't at OOM risk).
    const dir = mkdtempSync(join(tmpdir(), "cleetus-store-"));
    const caps: number[] = [];
    const resizer = async (_b: Buffer, _m: string, cap: number) => {
      caps.push(cap);
      return { bytes: Buffer.from("R") };
    };
    await storeImage(png(100, 80, 200), smallCaps, dir, resizeOn, resizer); // 224B > soft 100
    expect(caps).toEqual([1568]);
  });

  it("does not resize when under both triggers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleetus-store-"));
    const resizer = async () => {
      throw new Error("resizer must not run");
    };
    const src = png(100, 80); // 24B < soft, dims < cap
    const { ref, warning } = await storeImage(src, smallCaps, dir, resizeOn, resizer);
    expect(readFileSync(ref!.path).equals(src)).toBe(true);
    expect(warning).toBeUndefined();
  });

  it("does not resize when disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleetus-store-"));
    const resizer = async () => {
      throw new Error("resizer must not run");
    };
    const src = png(4032, 3024);
    const { ref } = await storeImage(
      src,
      smallCaps,
      dir,
      { enabled: false, maxDimension: 1568 },
      resizer,
    );
    expect(readFileSync(ref!.path).equals(src)).toBe(true);
  });

  it("passes through the original + warns when the resizer fails on a genuinely oversized image", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleetus-store-"));
    const resizer = async () => ({ error: "no resizer" });
    const src = png(4032, 3024, 200); // over soft + over dim — the dimension is what matters here
    const { ref, warning } = await storeImage(src, smallCaps, dir, resizeOn, resizer);
    expect(readFileSync(ref!.path).length).toBe(src.length);
    // Dimension-based wording: names the actual pixel dimensions and the configured cap, not
    // byte size — the warning is honest about what actually risks an OOM (pixel count).
    expect(warning).toContain("4032x3024");
    expect(warning).toContain("1568px cap");
    expect(warning).toContain("full size");
  });

  it("rejects over the hard cap on the original bytes without resizing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleetus-store-"));
    const resizer = async () => {
      throw new Error("resizer must not run");
    };
    const tinyHard: VisionConfig = { ...DEFAULT_VISION, maxBytesSoft: 50, maxBytesHard: 100 };
    const { error, ref } = await storeImage(png(4032, 3024, 200), tinyHard, dir, resizeOn, resizer);
    expect(error).toContain("too large");
    expect(ref).toBeUndefined();
  });
});
