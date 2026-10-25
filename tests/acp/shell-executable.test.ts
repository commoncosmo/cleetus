import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildAcpRuntime } from "../../src/acp/runtime";

test.skipIf(process.platform !== "win32")(
  "rejects relative and missing shell overrides before startup",
  async () => {
    await expect(buildAcpRuntime({ shellExecutable: "pwsh.exe" })).rejects.toThrow("absolute path");
    await expect(
      buildAcpRuntime({ shellExecutable: join(process.cwd(), "missing-pwsh.exe") }),
    ).rejects.toThrow("not an accessible executable file");
  },
);

test.skipIf(process.platform === "win32")(
  "does not silently ignore the Windows shell option on another OS",
  async () => {
    await expect(buildAcpRuntime({ shellExecutable: "/bin/sh" })).rejects.toThrow(
      "Windows PowerShell only",
    );
  },
);
