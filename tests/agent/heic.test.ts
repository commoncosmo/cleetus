import { expect, test } from "bun:test";
import { looksLikeHeic, transcodeHeicToJpeg } from "../../src/agent/heic";

function heicBuffer(brand: string): Buffer {
  const buf = Buffer.alloc(20);
  buf.write("ftyp", 4, "ascii");
  buf.write(brand, 8, "ascii");
  return buf;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

test("looksLikeHeic is true for a crafted ftyp box with a HEIC brand", () => {
  expect(looksLikeHeic(heicBuffer("heic"))).toBe(true);
  expect(looksLikeHeic(heicBuffer("mif1"))).toBe(true);
  expect(looksLikeHeic(heicBuffer("heix"))).toBe(true);
});

test("looksLikeHeic is false for non-HEIC images and short buffers", () => {
  expect(looksLikeHeic(PNG)).toBe(false);
  expect(looksLikeHeic(JPEG)).toBe(false);
  expect(looksLikeHeic(Buffer.from([0x89]))).toBe(false);
  expect(looksLikeHeic(heicBuffer("mp41"))).toBe(false);
});

test("transcodeHeicToJpeg returns the transcoded bytes when the injected runner succeeds", () => {
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const runner = (_inPath: string, outPath: string): boolean => {
    require("node:fs").writeFileSync(outPath, fakeJpeg);
    return true;
  };
  // Pin platform to darwin so the success path runs regardless of the host OS (e.g. Linux CI).
  const r = transcodeHeicToJpeg(Buffer.from("fake heic bytes"), runner, "darwin");
  expect(r.error).toBeUndefined();
  expect(r.bytes?.equals(fakeJpeg)).toBe(true);
});

test("transcodeHeicToJpeg returns a friendly error when the runner fails", () => {
  const runner = (_inPath: string, _outPath: string): boolean => false;
  const r = transcodeHeicToJpeg(Buffer.from("fake heic bytes"), runner, "darwin");
  expect(r.bytes).toBeUndefined();
  expect(r.error).toBeTruthy();
});

test("transcodeHeicToJpeg returns the convert-first message off macOS without invoking the runner", () => {
  let ran = false;
  const runner = (): boolean => {
    ran = true;
    return true;
  };
  const r = transcodeHeicToJpeg(Buffer.from("fake heic bytes"), runner, "linux");
  expect(ran).toBe(false);
  expect(r.bytes).toBeUndefined();
  expect(r.error).toContain("convert to JPEG or PNG first");
});
