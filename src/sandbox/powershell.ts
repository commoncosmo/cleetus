import { SandboxUnavailableError } from "./types";

/** App execution aliases work at the host boundary but cannot be uv_spawn'ed inside
 * MXC. The underlying packaged executable is also unsupported; fail before a turn
 * instead of silently substituting another installation or weakening containment. */
export async function resolvePowerShell(path: string | null): Promise<string | null> {
  if (path && /[\\/]WindowsApps[\\/]/i.test(path))
    throw new SandboxUnavailableError(
      "The selected WindowsApps/MSIX PowerShell installation cannot run inside native MXC. Install an unpackaged PowerShell 7.4+ MSI or ZIP alongside it and put that pwsh.exe first on PATH. MSI: winget install --id Microsoft.PowerShell --exact --source winget --installer-type wix",
    );
  return path;
}
