import { isAbsolute, join, resolve } from "node:path";

/** Resolve the cleetus config root. An explicit `--config-dir` wins (absolutized against `cwd`
 *  when relative); otherwise the default `~/.config/cleetus`. Pure — `home`/`cwd` are injected so
 *  the whole thing is testable. */
export function resolveConfigRoot(
  configDir: string | undefined,
  home: string,
  cwd: string,
): string {
  if (configDir?.trim()) {
    return isAbsolute(configDir) ? configDir : resolve(cwd, configDir);
  }
  return join(home, ".config", "cleetus");
}
