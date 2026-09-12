/** The file's dominant line ending: "\r\n" when CRLF lines outnumber lone-LF lines, else
 *  "\n". Ties, newline-less text, and empty text default to "\n". Pure. */
export function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf; // lone LF (not part of a CRLF)
  return crlf > lf ? "\r\n" : "\n";
}
