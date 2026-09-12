/** Encode a Float32Array as little-endian f32 bytes for BLOB storage. */
export function encodeVector(vec: Float32Array): Uint8Array {
  // .slice() copies into a fresh, offset-0 buffer so storage never aliases the input.
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength).slice();
}

/** Decode BLOB bytes (as returned by bun:sqlite) back into a Float32Array. */
export function decodeVector(blob: Uint8Array): Float32Array {
  // Copy first: guarantees 4-byte alignment and an independent buffer.
  const copy = blob.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
