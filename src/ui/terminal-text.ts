/** Remove terminal control sequences before displaying untrusted/model-produced text. */
export function sanitizeTerminalText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        // CSI: consume through its final byte.
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
          index += 1;
        }
      } else if (next === 0x5d) {
        // OSC: consume through BEL or ST (ESC backslash).
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current === 0x07) break;
          if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
            index += 1;
            break;
          }
          index += 1;
        }
      } else if (index + 1 < value.length) {
        index += 1;
      }
      continue;
    }
    if (code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f && code < 0x80)) {
      result += value[index];
      continue;
    }
    if (code >= 0xa0) result += value[index];
  }
  return result;
}
