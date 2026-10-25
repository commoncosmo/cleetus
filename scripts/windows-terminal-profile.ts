import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { windowsQuote } from "../src/sandbox/windows";

const executable = resolve(process.argv[2] ?? "dist/cleetus.exe");
const output = resolve("dist/windows-terminal/Cleetus.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    {
      profiles: [
        {
          guid: "{a9900468-1bd8-4d8e-b0f1-fcfaa43fba8d}",
          name: "Cleetus",
          commandline: windowsQuote(executable),
          hidden: false,
        },
      ],
    },
    null,
    2,
  ),
);
console.log(`Generated ${output}; review before installing as a Windows Terminal fragment.`);
