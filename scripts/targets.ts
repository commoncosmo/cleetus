/** A single release build target. */
export interface BuildTarget {
  /** Value passed to `bun build --target`, e.g. "bun-darwin-arm64". */
  bunTarget: string;
  /** Published Release asset filename, e.g. "cleetus-darwin-arm64". */
  asset: string;
  /** OS family — decides runner and whether code signing applies. */
  os: "linux" | "darwin";
}

/** The four targets the release pipeline produces. */
export const TARGETS: BuildTarget[] = [
  { bunTarget: "bun-linux-x64", asset: "cleetus-linux-x64", os: "linux" },
  { bunTarget: "bun-linux-arm64", asset: "cleetus-linux-arm64", os: "linux" },
  { bunTarget: "bun-darwin-arm64", asset: "cleetus-darwin-arm64", os: "darwin" },
  { bunTarget: "bun-darwin-x64", asset: "cleetus-darwin-x64", os: "darwin" },
];

/** Map a bun target to its Release asset filename. Throws on an unknown target. */
export function assetName(bunTarget: string): string {
  const target = TARGETS.find((entry) => entry.bunTarget === bunTarget);
  if (!target) throw new Error(`unknown build target: ${bunTarget}`);
  return target.asset;
}
