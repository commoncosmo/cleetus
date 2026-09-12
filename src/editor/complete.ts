import type { SkillRegistry } from "../skills/registry";
import type { Suggestion } from "../ui/tui/input";
import type { EditableArtifactKind } from "./artifacts";

export interface EditorCompletionSources {
  workflows?: () => Array<{ name: string; source: "project" | "global" }>;
  skills: SkillRegistry;
  artifacts?: (kind: EditableArtifactKind) => string[];
}

interface CompletionCandidate {
  token: string;
  display: string;
  value: string;
  fillOnly?: boolean;
}

function matching(
  partial: string,
  candidates: CompletionCandidate[],
  policy: "prefix" | "substring" = "prefix",
): Suggestion[] {
  const normalized = partial.toLowerCase();
  return candidates
    .filter((candidate) => {
      const token = candidate.token.toLowerCase();
      return policy === "substring" ? token.includes(normalized) : token.startsWith(normalized);
    })
    .sort((left, right) => left.token.localeCompare(right.token))
    .map(({ display, value, fillOnly }) =>
      fillOnly ? { display, value, fillOnly } : { display, value },
    );
}

function subcommand(
  line: string,
  command: string,
  description: string,
  requiredArgument: boolean,
): Suggestion[] | undefined {
  const match = new RegExp(`^/${command}\\s+([^\\s]*)$`, "u").exec(line);
  if (!match) return undefined;
  return matching(match[1]!, [
    {
      token: "edit",
      display: `edit — ${description}`,
      value: `/${command} edit `,
      fillOnly: requiredArgument,
    },
  ]);
}

function scoped(
  line: string,
  command: string,
  scopes: Array<{ name: string; description: string }>,
): Suggestion[] | undefined {
  const match = new RegExp(`^/${command}\\s+edit\\s+([^\\s]*)$`, "u").exec(line);
  if (!match) return undefined;
  return matching(
    match[1]!,
    scopes.map(({ name, description }) => ({
      token: name,
      display: `${name} — ${description}`,
      value: `/${command} edit ${name}`,
    })),
  );
}

/**
 * Bounded completions for editor-aware slash commands. Candidate discovery is
 * intentionally limited to Cleetus registries and direct artifact roots.
 */
export function completeEditorLine(sources: EditorCompletionSources, line: string): Suggestion[] {
  if (!line.startsWith("/") || line.includes("\n")) return [];

  const outside = /^\/edit\s+([^\s]*)$/u.exec(line);
  if (outside) {
    return matching(outside[1]!, [
      {
        token: "--create",
        display: "--create — create one new file inside the project",
        value: "/edit --create ",
        fillOnly: true,
      },
      {
        token: "--outside-project",
        display: "--outside-project — request one-time access to external targets",
        value: "/edit --outside-project ",
        fillOnly: true,
      },
    ]);
  }

  const workflowName = /^\/workflow\s+edit\s+([^\s]*)$/u.exec(line);
  if (workflowName) {
    return matching(
      workflowName[1]!,
      (sources.workflows?.() ?? []).map((workflow) => ({
        token: workflow.name,
        display: `${workflow.name} — ${workflow.source} workflow`,
        value: `/workflow edit ${workflow.name} `,
      })),
      "substring",
    );
  }
  const workflowScope = /^\/workflow\s+edit\s+([^\s]+)\s+([^\s]*)$/u.exec(line);
  if (workflowScope) {
    return matching(workflowScope[2]!, [
      {
        token: "--global",
        display: "--global — edit the global workflow package",
        value: `/workflow edit ${workflowScope[1]} --global`,
      },
      {
        token: "--project",
        display: "--project — edit the project workflow package",
        value: `/workflow edit ${workflowScope[1]} --project`,
      },
    ]);
  }
  const workflow = subcommand(line, "workflow", "open an isolated manual workflow revision", true);
  if (workflow) return workflow;

  const skillName = /^\/skill\s+edit\s+([^\s]*)$/u.exec(line);
  if (skillName) {
    return matching(
      skillName[1]!,
      sources.skills
        .list()
        .filter((skill) => skill.filePath)
        .map((skill) => ({
          token: skill.name,
          display: `${skill.name} — ${skill.source} skill`,
          value: `/skill edit ${skill.name}`,
        })),
      "substring",
    );
  }
  const skill = subcommand(line, "skill", "open and reload a user-authored skill", true);
  if (skill) return skill;

  const projectGlobal = [
    { name: "project", description: "edit the project source" },
    { name: "global", description: "edit the global source" },
  ];
  for (const command of ["config", "permissions"]) {
    const scopes = scoped(line, command, projectGlobal);
    if (scopes) return scopes;
    const action = subcommand(line, command, `edit ${command} settings`, false);
    if (action) return action;
  }

  const instructionScopes = scoped(line, "instructions", [
    ...projectGlobal,
    { name: "cleetus", description: "edit the nearest CLEETUS.md source" },
  ]);
  if (instructionScopes) return instructionScopes;
  const instructions = subcommand(line, "instructions", "edit an instruction source", false);
  if (instructions) return instructions;

  for (const kind of ["spec", "plan"] as const) {
    const artifact = new RegExp(`^/${kind}\\s+edit\\s+(.*)$`, "u").exec(line);
    if (artifact) {
      return matching(
        artifact[1]!,
        (sources.artifacts?.(kind) ?? []).map((path) => ({
          token: path,
          display: `${path} — ${kind} artifact`,
          value: `/${kind} edit ${path}`,
        })),
        "substring",
      );
    }
    const action = subcommand(line, kind, `edit a known ${kind} artifact`, false);
    if (action) return action;
  }

  return [];
}
