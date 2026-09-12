import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { confinedEditorRoot, confinedEditorTarget } from "./paths";

export type EditableArtifactKind = "spec" | "plan";
const MAX_ARTIFACT_COMPLETIONS = 100;

function artifactRoot(input: {
  kind: EditableArtifactKind;
  projectDir: string;
  specsDir: string;
}): string {
  return input.kind === "spec"
    ? resolve(input.projectDir, input.specsDir)
    : resolve(input.projectDir, ".cleetus", "plans");
}

function latestMarkdown(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => {
      const path = resolve(root, entry.name);
      return { path, modified: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified || right.path.localeCompare(left.path))[0]
    ?.path;
}

export function resolveArtifactEditTarget(input: {
  kind: EditableArtifactKind;
  projectDir: string;
  specsDir: string;
  requested?: string;
  current?: string;
}): string {
  const root = artifactRoot(input);
  if (!existsSync(root)) {
    throw new Error(`no ${input.kind} artifact is available to edit`);
  }
  const securedRoot = confinedEditorRoot({
    boundary: input.projectDir,
    root,
    label: `${input.kind} artifact root`,
  });
  const candidateText = input.requested?.trim() || input.current?.trim();
  const candidate = candidateText
    ? isAbsolute(candidateText)
      ? resolve(candidateText)
      : resolve(input.projectDir, candidateText)
    : latestMarkdown(securedRoot);

  if (!candidate) {
    throw new Error(`no ${input.kind} artifact is available to edit`);
  }
  return confinedEditorTarget({
    root: securedRoot,
    target: candidate,
    label: `${input.kind} artifact`,
  });
}

/**
 * Return a bounded, non-recursive list of editable Markdown artifacts for TUI
 * completion. Values are always project-relative; unsafe symlinks and any root
 * that does not remain inside the project are omitted.
 */
export function listArtifactEditTargets(input: {
  kind: EditableArtifactKind;
  projectDir: string;
  specsDir: string;
}): string[] {
  const root = artifactRoot(input);
  if (!existsSync(root)) return [];
  try {
    const securedRoot = confinedEditorRoot({
      boundary: input.projectDir,
      root,
      label: `${input.kind} artifact root`,
    });
    const projectRoot = realpathSync(input.projectDir);
    return readdirSync(securedRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) =>
        confinedEditorTarget({
          root: securedRoot,
          target: resolve(securedRoot, entry.name),
          label: `${input.kind} artifact`,
        }),
      )
      .map((path) => relative(projectRoot, path).split(sep).join("/"))
      .filter((path) => path !== "" && path !== ".." && !path.startsWith("../"))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_ARTIFACT_COMPLETIONS);
  } catch {
    return [];
  }
}
