import { posix, win32 } from "node:path";

export function pathApi(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? win32 : posix;
}

/** Comparison only; callers retain the original spelling for actual IO. */
export function comparablePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = pathApi(platform).normalize(value);
  return platform === "win32"
    ? normalized
        .replace(/^\\\\\?\\UNC\\/i, "\\\\")
        .replace(/^\\\\\?\\/, "")
        .toLowerCase()
    : normalized;
}

/** Callers must resolve symlinks first when this is used as an authorization boundary. */
export function isPathWithin(
  root: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = pathApi(platform);
  const rel = api.relative(comparablePath(root, platform), comparablePath(target, platform));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel));
}

export function expandHomePath(
  value: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) {
    return pathApi(platform).join(home, value.slice(2));
  }
  return value;
}
