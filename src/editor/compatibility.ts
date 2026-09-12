import { parseEditorWords } from "./words";

export type EditorSurface = "terminal" | "graphical";
export type EditorPlatform = "all" | "darwin";

export interface EditorCompatibilityProfile {
  id: string;
  label: string;
  command: string;
  executable: string;
  surface: EditorSurface;
  platform: EditorPlatform;
  waitBehavior: string;
}

export const EDITOR_COMPATIBILITY_PROFILES: readonly EditorCompatibilityProfile[] = [
  {
    id: "vi",
    label: "Vi / system Vim",
    command: "vi",
    executable: "vi",
    surface: "terminal",
    platform: "all",
    waitBehavior: "The terminal returns when the editor exits.",
  },
  {
    id: "vim",
    label: "Vim",
    command: "vim",
    executable: "vim",
    surface: "terminal",
    platform: "all",
    waitBehavior: "The terminal returns when Vim exits.",
  },
  {
    id: "nvim",
    label: "Neovim",
    command: "nvim",
    executable: "nvim",
    surface: "terminal",
    platform: "all",
    waitBehavior: "The terminal returns when Neovim exits.",
  },
  {
    id: "helix",
    label: "Helix",
    command: "hx",
    executable: "hx",
    surface: "terminal",
    platform: "all",
    waitBehavior: "The terminal returns when Helix exits.",
  },
  {
    id: "code-wait",
    label: "Visual Studio Code",
    command: "code --wait",
    executable: "code",
    surface: "graphical",
    platform: "all",
    waitBehavior: "The --wait flag returns after the opened files close.",
  },
  {
    id: "bbedit",
    label: "BBEdit",
    command: "bbedit --wait",
    executable: "bbedit",
    surface: "graphical",
    platform: "darwin",
    waitBehavior: "The --wait flag returns after the opened document closes.",
  },
  {
    id: "gvim",
    label: "gVim",
    command: "gvim -f",
    executable: "gvim",
    surface: "graphical",
    platform: "all",
    waitBehavior: "The -f flag keeps gVim in the foreground until its window closes.",
  },
  {
    id: "macvim",
    label: "MacVim",
    command: "mvim -f",
    executable: "mvim",
    surface: "graphical",
    platform: "darwin",
    waitBehavior: "The -f flag keeps mvim in the foreground until its window closes.",
  },
  {
    id: "textedit",
    label: "TextEdit via macOS open",
    command: "open -W -a TextEdit",
    executable: "open",
    surface: "graphical",
    platform: "darwin",
    waitBehavior: "The -W flag waits for TextEdit to terminate; quit the app after saving.",
  },
] as const;

export function editorCompatibilityProfile(id: string): EditorCompatibilityProfile | undefined {
  return EDITOR_COMPATIBILITY_PROFILES.find((profile) => profile.id === id);
}

export function profileSupportsPlatform(
  profile: EditorCompatibilityProfile,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return profile.platform === "all" || (profile.platform === "darwin" && platform === "darwin");
}

export function validateCompatibilityProfiles(
  profiles: readonly EditorCompatibilityProfile[] = EDITOR_COMPATIBILITY_PROFILES,
): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) issues.push(`duplicate profile id: ${profile.id}`);
    ids.add(profile.id);
    let argv: string[] = [];
    try {
      argv = parseEditorWords(profile.command, `editor profile '${profile.id}'`);
    } catch (error) {
      issues.push((error as Error).message);
      continue;
    }
    if (argv[0] !== profile.executable) {
      issues.push(
        `profile '${profile.id}' executable '${profile.executable}' does not match command '${argv[0] ?? ""}'`,
      );
    }
  }
  return issues;
}

export const EDITOR_SMOKE_MARKER = "CLEETUS_EDITOR_SMOKE=passed";

export function editorSmokeDocument(profile: EditorCompatibilityProfile): string {
  return [
    "# Cleetus editor compatibility smoke",
    "",
    `Profile: ${profile.label}`,
    "",
    "Replace the word `pending` below with `passed`, save the file, then close the editor.",
    "For launchers that wait on the application, quit the application after saving.",
    "",
    "CLEETUS_EDITOR_SMOKE=pending",
    "",
  ].join("\n");
}

export function editorSmokePassed(content: string): boolean {
  return content.split(/\r?\n/u).some((line) => line.trim() === EDITOR_SMOKE_MARKER);
}
