import { cpSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

if (process.platform !== "win32") throw new Error("Run this proof on Windows");
const out = resolve(process.argv[2] ?? "dist/mxc-poc/package");
mkdirSync(join(out, "native"), { recursive: true });
// Keep Koffi's dynamic native-module lookup intact. No global Node/Bun installation is needed.
for (const name of ["koffi", "@koromix", "semver"]) {
  cpSync(resolve("experiments/mxc/node_modules", name), join(out, "node_modules", name), {
    recursive: true,
  });
}
const sdk = resolve("experiments/mxc/node_modules/@microsoft/mxc-sdk");
for (const name of ["dist", "package.json", "LICENSE.md"]) {
  cpSync(join(sdk, name), join(out, "node_modules/@microsoft/mxc-sdk", name), { recursive: true });
}
cpSync(
  resolve(`experiments/mxc/node_modules/@microsoft/mxc-sdk/bin/${process.arch}/mxc_ffi.dll`),
  join(out, "native/mxc_ffi.dll"),
);
cpSync(
  resolve(`experiments/mxc/node_modules/@microsoft/mxc-sdk/bin/${process.arch}/wxc-exec.exe`),
  join(out, "native/wxc-exec.exe"),
);
const build = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "experiments/mxc/entry.ts",
    "--compile",
    "--external",
    "koffi",
    "--external",
    "node-pty",
    "--outfile",
    join(out, "cleetus.exe"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode) process.exit(build.exitCode);
console.log(out);
