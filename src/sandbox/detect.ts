/**
 * Pick the host-native sandbox backend for a platform. `sandbox-exec` ships with every
 * macOS, so darwin is always seatbelt; Linux uses bwrap only when the binary is present;
 * everything else (Windows included) has no host-native sandbox.
 */
export function detectHostBackend(
  platform: NodeJS.Platform,
  hasBwrap: () => boolean,
): "seatbelt" | "bwrap" | null {
  if (platform === "darwin") return "seatbelt";
  if (platform === "linux") return hasBwrap() ? "bwrap" : null;
  return null;
}
