import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { resizeImage } from "../../src/agent/resize";

const ORIG = Buffer.from("original-bytes");

/** Minimal PNG header: 8-byte signature, IHDR tag at 12, width@16/height@20 (BE). Enough for
 *  readImageDimensions to parse real dimensions and exercise the never-enlarge guard. */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe("resizeImage", () => {
  it("uses sips on darwin and returns its output", async () => {
    let reachedJimp = false;
    const r = await resizeImage(ORIG, "image/png", 1568, {
      platform: "darwin",
      sipsRunner: (_in, outPath, cap) => {
        writeFileSync(outPath, Buffer.from(`sips:${cap}`));
        return true;
      },
      jimpResize: async () => {
        reachedJimp = true;
        return Buffer.from("jimp");
      },
    });
    expect(r.bytes?.toString()).toBe("sips:1568");
    expect(reachedJimp).toBe(false);
  });

  it("falls back to jimp when sips fails on darwin", async () => {
    const r = await resizeImage(ORIG, "image/png", 800, {
      platform: "darwin",
      sipsRunner: () => false,
      jimpResize: async (_b, _m, cap) => Buffer.from(`jimp:${cap}`),
    });
    expect(r.bytes?.toString()).toBe("jimp:800");
  });

  it("skips sips entirely off darwin", async () => {
    const r = await resizeImage(ORIG, "image/png", 640, {
      platform: "linux",
      sipsRunner: () => {
        throw new Error("sips must not run off darwin");
      },
      jimpResize: async (_b, _m, cap) => Buffer.from(`jimp:${cap}`),
    });
    expect(r.bytes?.toString()).toBe("jimp:640");
  });

  it("returns an error when both resizers fail", async () => {
    const r = await resizeImage(ORIG, "image/png", 1568, {
      platform: "linux",
      jimpResize: async () => {
        throw new Error("boom");
      },
    });
    expect(r.bytes).toBeUndefined();
    expect(r.error).toBeTruthy();
  });

  it("never-enlarge guard: returns original bytes unchanged and calls neither resizer when already within cap", async () => {
    const small = pngHeader(100, 80);
    let sipsCalled = false;
    let jimpCalled = false;
    const r = await resizeImage(small, "image/png", 1568, {
      platform: "darwin",
      sipsRunner: () => {
        sipsCalled = true;
        throw new Error("sips must not run when already within cap");
      },
      jimpResize: async () => {
        jimpCalled = true;
        throw new Error("jimp must not run when already within cap");
      },
    });
    expect(r.bytes).toBe(small);
    expect(sipsCalled).toBe(false);
    expect(jimpCalled).toBe(false);
  });

  it("never-enlarge guard: falls through to the resizer when the image exceeds cap", async () => {
    const large = pngHeader(4032, 3024);
    let sipsCalled = false;
    const r = await resizeImage(large, "image/png", 1568, {
      platform: "darwin",
      sipsRunner: (_in, outPath, cap) => {
        sipsCalled = true;
        writeFileSync(outPath, Buffer.from(`sips:${cap}`));
        return true;
      },
      jimpResize: async () => {
        throw new Error("jimp should not be reached; sips should have handled it");
      },
    });
    expect(sipsCalled).toBe(true);
    expect(r.bytes?.toString()).toBe("sips:1568");
  });
});
