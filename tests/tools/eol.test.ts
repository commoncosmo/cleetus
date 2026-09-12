import { expect, test } from "bun:test";
import { dominantEol } from "../../src/tools/eol";

test("pure CRLF text yields CRLF", () => {
  expect(dominantEol("a\r\nb\r\n")).toBe("\r\n");
});
test("pure LF text yields LF", () => {
  expect(dominantEol("a\nb\n")).toBe("\n");
});
test("majority-CRLF mixed text yields CRLF", () => {
  expect(dominantEol("a\r\nb\r\nc\n")).toBe("\r\n"); // 2 CRLF vs 1 lone LF
});
test("majority-LF mixed text yields LF", () => {
  expect(dominantEol("a\r\nb\nc\n")).toBe("\n"); // 1 CRLF vs 2 lone LF
});
test("text with no newline yields LF", () => {
  expect(dominantEol("abc")).toBe("\n");
});
test("empty text yields LF", () => {
  expect(dominantEol("")).toBe("\n");
});
