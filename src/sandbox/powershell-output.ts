import { stripVTControlCharacters } from "node:util";
import type { ExecResult } from "./types";

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);|&#(\d+);|&(lt|gt|amp|quot|apos);/gi, (_m, hex, decimal, named) => {
      if (hex || decimal) {
        const n = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
        return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
      }
      return (
        ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[
          named.toLowerCase()
        ] ?? _m
      );
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
/** Extract only serialized strings; never resolve XML entities or execute a parser/DTD. */
export function plainPowerShellOutput(text: string): string {
  return stripVTControlCharacters(
    text.replace(/#< CLIXML\r?\n(<Objs\b[\s\S]*?<\/Objs>)/g, (_whole, xml: string) => {
      const strings: string[] = [];
      let depth = 0;
      for (const token of xml.matchAll(/<Obj\b[^>]*>|<\/Obj>|<S\b[^>]*>([\s\S]*?)<\/S>/g)) {
        if ((token[0].startsWith("<Obj ") || token[0] === "<Obj>") && !token[0].endsWith("/>"))
          depth++;
        else if (token[0] === "</Obj>") depth--;
        else if (depth === 0 && !/\bS="(?:progress|information)"/i.test(token[0]))
          strings.push(decode(token[1]!));
      }
      return strings.join("");
    }),
  );
}
export function normalizeWindowsResult(result: ExecResult): ExecResult {
  let stderr = plainPowerShellOutput(result.stderr);
  const stdout = plainPowerShellOutput(result.stdout);
  const marker = stderr.indexOf("The target executable '");
  if (
    marker >= 0 &&
    stderr.slice(marker).includes("appears to be a packaged (MSIX) app.") &&
    (stdout.trim() || stderr.slice(0, marker).trim())
  ) {
    stderr = stderr.slice(0, marker).trimEnd();
  }
  return { ...result, stdout, stderr };
}
