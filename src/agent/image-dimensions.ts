/** Width/height read from image header bytes — no decode, no dependency, every platform.
 *  Supports the four MIME types sniffImageMime recognizes. null if unparseable. */
export function readImageDimensions(
  bytes: Buffer,
  mime: string,
): { width: number; height: number } | null {
  if (mime === "image/png") {
    if (bytes.length < 24) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  if (mime === "image/gif") {
    if (bytes.length < 10) return null;
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }

  if (mime === "image/jpeg") {
    let off = 2; // skip the SOI marker (FF D8)
    while (off + 1 < bytes.length) {
      if (bytes[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = bytes[off + 1] as number;
      if (marker === 0xff) {
        off++; // fill byte
        continue;
      }
      // SOF0..SOF15 carry dimensions, except DHT (C4), JPG (C8), DAC (CC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (off + 8 >= bytes.length) return null;
        return { width: bytes.readUInt16BE(off + 7), height: bytes.readUInt16BE(off + 5) };
      }
      if (off + 3 >= bytes.length) return null;
      off += 2 + bytes.readUInt16BE(off + 2); // skip this segment
    }
    return null;
  }

  if (mime === "image/webp") {
    if (bytes.length < 30) return null;
    const fourcc = bytes.subarray(12, 16).toString("ascii");
    if (fourcc === "VP8X") {
      const w =
        (bytes[24] as number) | ((bytes[25] as number) << 8) | ((bytes[26] as number) << 16);
      const h =
        (bytes[27] as number) | ((bytes[28] as number) << 8) | ((bytes[29] as number) << 16);
      return { width: w + 1, height: h + 1 };
    }
    if (fourcc === "VP8L") {
      // signature byte 0x2f at offset 20, then 14-bit (w-1) and (h-1) packed LE from offset 21
      if (bytes[20] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8 ") {
      // lossy: 3-byte start code 0x9d 0x01 0x2a at 23..25, then 14-bit width@26 / height@28 (LE)
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    return null;
  }

  return null;
}
