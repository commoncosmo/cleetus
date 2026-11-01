import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { terminalProfile } from "../src/windows/terminal";

const executable = resolve(process.argv[2] ?? "dist/cleetus.exe");
const output = resolve("dist/windows-terminal/Cleetus.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    terminalProfile({ executable, args: [] }),
    null,
    2,
  ),
);
console.log(`Generated ${output}; review before installing as a Windows Terminal fragment.`);
