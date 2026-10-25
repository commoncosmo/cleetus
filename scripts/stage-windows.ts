import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Only the executor is distributed. The Node SDK and native addons are build-time inputs. */
export function stageWindowsRuntime(outfile: string, arch: string): void {
  if (arch !== "arm64" && arch !== "x64")
    throw new Error(`unsupported Windows architecture: ${arch}`);
  const sdk = dirname(Bun.resolveSync("@microsoft/mxc-sdk/package.json", import.meta.dir));
  mkdirSync(join(dirname(outfile), "native"), { recursive: true });
  copyFileSync(
    join(sdk, "bin", arch, "wxc-exec.exe"),
    join(dirname(outfile), "native/wxc-exec.exe"),
  );
  copyFileSync(join(sdk, "LICENSE.md"), join(dirname(outfile), "native/MXC-LICENSE.md"));
  // Preserve upstream's bundled-native software inventory and notices.
  cpSync(join(sdk, "bin", arch, "_manifest"), join(dirname(outfile), "native/_manifest"), {
    recursive: true,
  });
}
