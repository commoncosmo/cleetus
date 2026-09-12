import { describe, expect, it } from "bun:test";
import { readImageDimensions } from "../../src/agent/image-dimensions";

/** Minimal PNG header: 8-byte signature, IHDR tag at 12, width@16/height@20 (BE). */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** Minimal GIF header: "GIF89a", then width@6/height@8 (LE). */
function gifHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(10);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

/** Minimal JPEG: SOI then an SOF0 segment carrying height then width (BE). */
function jpegHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(12);
  b[0] = 0xff;
  b[1] = 0xd8; // SOI
  b[2] = 0xff;
  b[3] = 0xc0; // SOF0
  b.writeUInt16BE(8, 4); // segment length
  b[6] = 8; // sample precision
  b.writeUInt16BE(h, 7); // height
  b.writeUInt16BE(w, 9); // width
  return b;
}

/** Minimal WEBP VP8X: "RIFF"/"WEBP"/"VP8X", canvas (w-1)@24 / (h-1)@27, each 3 bytes LE. */
function webpVp8x(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16); // chunk size
  const wm = w - 1;
  const hm = h - 1;
  b[24] = wm & 0xff;
  b[25] = (wm >> 8) & 0xff;
  b[26] = (wm >> 16) & 0xff;
  b[27] = hm & 0xff;
  b[28] = (hm >> 8) & 0xff;
  b[29] = (hm >> 16) & 0xff;
  return b;
}

describe("readImageDimensions", () => {
  it("parses PNG width/height from IHDR", () => {
    expect(readImageDimensions(pngHeader(4032, 3024), "image/png")).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it("parses GIF width/height (little-endian)", () => {
    expect(readImageDimensions(gifHeader(640, 480), "image/gif")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("parses JPEG width/height from the SOF0 marker", () => {
    expect(readImageDimensions(jpegHeader(1200, 900), "image/jpeg")).toEqual({
      width: 1200,
      height: 900,
    });
  });

  it("parses WEBP (VP8X) canvas width/height", () => {
    expect(readImageDimensions(webpVp8x(100, 80), "image/webp")).toEqual({
      width: 100,
      height: 80,
    });
  });

  it("returns null for truncated data and unknown mime", () => {
    expect(readImageDimensions(Buffer.from("nope"), "image/png")).toBeNull();
    expect(readImageDimensions(pngHeader(10, 10), "image/tiff")).toBeNull();
  });
});
