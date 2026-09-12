import type { CheckpointSummary } from "../checkpoint/types";
import type { LearnPlaybookController } from "../learn/service";
import type { McpServerStatus } from "../mcp/types";
import type { MemoryStore } from "../memory/store";
import type { PermissionRules } from "../permission/types";
import { composeSkillTurn } from "../skills/compose";
import type { SkillRegistry } from "../skills/registry";
import type { WorkflowCommandController } from "../workflows/interactive-controller";

export interface AcpAvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

export type AcpCommandResult =
  | { kind: "text"; text: string }
  | { kind: "handled" }
  | { kind: "agent-turn"; prompt: string };

export interface AcpCommandHandler {
  /** Complete command snapshot advertised through ACP for every new/loaded session. */
  availableCommands(): AcpAvailableCommand[];
  /** Execute an advertised slash command, or return null when the input is ordinary prose. */
  execute(
    input: string,
    context: { sessionId: string; signal?: AbortSignal },
  ): Promise<AcpCommandResult | null>;
}

export interface AcpCommandServices {
  workflowController?: WorkflowCommandController;
  learnPlaybookForSession?: (sessionId: string) => LearnPlaybookController;
  buildSpecSeed?: (idea: string) => string | undefined;
  clearSession?: (sessionId: string) => Promise<void> | void;
  compactSession?: (
    sessionId: string,
    instruction?: string,
  ) => Promise<{
    compacted: boolean;
    messagesFolded: number;
    beforeTokens: number;
    afterTokens: number;
    partial: boolean;
  }>;
  getInstructions?: () => string;
  memory?: { global: MemoryStore; project: MemoryStore };
  getPermissions?: (sessionId: string) => Promise<PermissionRules>;
  getMcpStatus?: (sessionId: string) => McpServerStatus[];
  getMaxLoops?: (sessionId: string) => number;
  setMaxLoops?: (sessionId: string, value: number) => void;
  getCheckpoints?: (sessionId: string) => CheckpointSummary[];
  rewindToCheckpoint?: (sessionId: string, turnNumber: number) => Promise<boolean>;
  runInsights?: (sessionId: string, args: string, signal?: AbortSignal) => Promise<string>;
  /** Returns user-facing status/error text, or undefined after emitting findings into the
   * session event stream. */
  runReview?: (
    sessionId: string,
    args: string,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  runIndex?: (sessionId: string, args: string, signal?: AbortSignal) => Promise<string>;
}

function parseCommand(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: match[2]?.trim() ?? "" };
}

function formatKTokens(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

/** ACP command surface backed by the live skill registry. Only commands implemented here are
 * advertised: terminal-only commands must never appear merely because the TUI knows about them. */
export function createAcpCommandHandler(
  skills: SkillRegistry,
  services: AcpCommandServices = {},
): AcpCommandHandler {
  return {
    availableCommands: () => {
      const commands: AcpAvailableCommand[] = [
        {
          name: "skill",
          description: "Run a skill playbook, or list available skills",
          input: { hint: "<name> [arguments]" },
        },
      ];
      if (services.workflowController) {
        commands.push({
          name: "workflow",
          description: "Create, inspect, validate, run, test, or view strict workflows",
          input: {
            hint: "<create|status|review|discard|list|show|validate|dry-run|run|history|test> [name]",
          },
        });
      }
      if (services.learnPlaybookForSession) {
        commands.push({
          name: "learn",
          description: "Draft or refine a playbook from the previous turn",
          input: { hint: "[status|discard|save project|save global]" },
        });
      }
      if (services.buildSpecSeed) {
        commands.push({
          name: "spec",
          description: "Draft a specification interactively",
          input: { hint: "[rough idea]" },
        });
      }
      if (services.clearSession) {
        commands.push({
          name: "clear",
          description: "Clear the conversation context",
        });
      }
      if (services.compactSession) {
        commands.push({
          name: "compact",
          description: "Summarize the conversation to shrink its context",
          input: { hint: "[instruction]" },
        });
      }
      if (services.getInstructions) {
        commands.push({
          name: "instructions",
          description: "Show the effective instruction text",
        });
      }
      if (services.memory) {
        commands.push({
          name: "memory",
          description: "List, add, or forget durable memories",
          input: { hint: "[list|add <text>|forget <number>]" },
        });
      }
      if (services.getPermissions) {
        commands.push({
          name: "permissions",
          description: "Show the effective permission rules",
        });
      }
      if (services.getMcpStatus) {
        commands.push({
          name: "mcp",
          description: "List connected MCP servers and tools",
        });
      }
      if (services.getMaxLoops && services.setMaxLoops) {
        commands.push({
          name: "maxloops",
          description: "Show or set the per-turn model round limit",
          input: { hint: "[unlimited|number]" },
        });
      }
      if (services.getCheckpoints && services.rewindToCheckpoint) {
        commands.push({
          name: "rewind",
          description: "Undo a turn and restore its files, conversation, and todos",
          input: { hint: "[checkpoint number]" },
        });
      }
      if (services.runInsights) {
        commands.push({
          name: "insights",
          description: "Analyze this session's tool reliability and turn efficiency",
          input: { hint: "[since 7d] [explain]" },
        });
      }
      if (services.runReview) {
        commands.push({
          name: "review",
          description: "Adversarially review working-tree changes",
          input: { hint: "[all|path|git ref]" },
        });
      }
      if (services.runIndex) {
        commands.push({
          name: "index",
          description: "Index this project for semantic code search",
          input: { hint: "[rebuild]" },
        });
      }
      return commands;
    },
    async execute(input, context) {
      const command = parseCommand(input);
      if (!command && services.workflowController) {
        const output: string[] = [];
        const handled = await services.workflowController.handleNatural(input, {
          print: (value) => output.push(value),
          signal: context.signal,
          sessionId: context.sessionId,
        });
        if (handled) return { kind: "text", text: output.join("\n") };
      }
      if (!command) return null;
      if (command.name === "workflow" && services.workflowController) {
        const output: string[] = [];
        await services.workflowController.handle(command.args, {
          print: (value) => output.push(value),
          signal: context.signal,
          sessionId: context.sessionId,
        });
        return { kind: "text", text: output.join("\n") };
      }
      if (command.name === "skill") {
        if (!command.args) {
          const lines = skills
            .list()
            .map(
              (skill) =>
                `${skill.source === "built-in" ? "  " : "* "}${skill.name} — ${skill.description}`,
            );
          return { kind: "text", text: [...lines, "type /skill <name> to run one"].join("\n") };
        }

        const separator = command.args.indexOf(" ");
        const nameArg = separator === -1 ? command.args : command.args.slice(0, separator);
        const args = separator === -1 ? "" : command.args.slice(separator + 1);
        const name = skills.resolveName(nameArg);
        if (!name) {
          const available = skills
            .list()
            .map((skill) => skill.name)
            .join(", ");
          return {
            kind: "text",
            text: `unknown skill '${nameArg}'. available: ${available}`,
          };
        }
        if (name === "workflow-creator") {
          if (!services.workflowController) {
            return { kind: "text", text: "workflow creation is unavailable in this host" };
          }
          const output: string[] = [];
          await services.workflowController.handle(
            `create${args.trim() ? ` ${args.trim()}` : ""}`,
            {
              print: (value) => output.push(value),
              signal: context.signal,
              sessionId: context.sessionId,
            },
          );
          return { kind: "text", text: output.join("\n") };
        }
        return { kind: "agent-turn", prompt: composeSkillTurn(skills.get(name)!, args) };
      }

      if (command.name === "spec" && services.buildSpecSeed) {
        const prompt = services.buildSpecSeed(command.args);
        return prompt
          ? { kind: "agent-turn", prompt }
          : { kind: "text", text: "spec-creator skill is unavailable" };
      }

      if (command.name === "clear" && services.clearSession) {
        if (command.args) return { kind: "text", text: "usage: /clear" };
        await services.clearSession(context.sessionId);
        return { kind: "text", text: "context cleared" };
      }

      if (command.name === "compact" && services.compactSession) {
        const result = await services.compactSession(context.sessionId, command.args || undefined);
        if (!result.compacted) {
          return {
            kind: "text",
            text: "Nothing to compact yet — context is already small.",
          };
        }
        const pct = Math.round((1 - result.afterTokens / Math.max(1, result.beforeTokens)) * 100);
        const plural = result.messagesFolded === 1 ? "" : "s";
        const partialNote = result.partial ? " (partial summary — summarizer was degraded.)" : "";
        return {
          kind: "text",
          text: `Compacted ${result.messagesFolded} message${plural}: ~${formatKTokens(result.beforeTokens)} → ~${formatKTokens(result.afterTokens)} tokens (-${pct}%).${partialNote}`,
        };
      }

      if (command.name === "instructions" && services.getInstructions) {
        if (command.args) return { kind: "text", text: "usage: /instructions" };
        const text = services.getInstructions();
        return {
          kind: "text",
          text: text.trim().length ? text : "(no instruction files found)",
        };
      }

      if (command.name === "memory" && services.memory) {
        const sub = command.args.split(/\s+/)[0]?.toLowerCase() ?? "";
        const rest = command.args.slice(sub.length).trim();
        if (sub === "add") {
          if (!rest) return { kind: "text", text: "usage: /memory add <text>" };
          services.memory.project.add(rest);
          return {
            kind: "text",
            text: `remembered (project) → ${services.memory.project.path}: ${rest}`,
          };
        }
        const globals = services.memory.global.list();
        const projects = services.memory.project.list();
        if (sub === "forget") {
          const n = Number(rest);
          if (!Number.isInteger(n) || n < 1) {
            return { kind: "text", text: "usage: /memory forget <number>" };
          }
          if (n <= globals.length) {
            services.memory.global.removeAt(n - 1);
            return { kind: "text", text: `forgot (global) ${n}: ${globals[n - 1]}` };
          }
          if (n <= globals.length + projects.length) {
            const localIndex = n - globals.length - 1;
            services.memory.project.removeAt(localIndex);
            return {
              kind: "text",
              text: `forgot (project) ${n}: ${projects[localIndex]}`,
            };
          }
          return { kind: "text", text: `no memory numbered ${n}` };
        }
        if (sub && sub !== "list") {
          return {
            kind: "text",
            text: "usage: /memory [list|add <text>|forget <number>]",
          };
        }
        if (globals.length === 0 && projects.length === 0) {
          return { kind: "text", text: "no memories yet" };
        }
        const lines: string[] = [];
        let n = 1;
        if (globals.length > 0) {
          lines.push("Global:");
          for (const memory of globals) lines.push(`  ${n++}. ${memory}`);
        }
        if (projects.length > 0) {
          lines.push("Project:");
          for (const memory of projects) lines.push(`  ${n++}. ${memory}`);
        }
        return { kind: "text", text: lines.join("\n") };
      }

      if (command.name === "permissions" && services.getPermissions) {
        if (command.args) return { kind: "text", text: "usage: /permissions" };
        const rules = await services.getPermissions(context.sessionId);
        const format = (label: string, entries: PermissionRules["project"]) => {
          if (entries.length === 0) return `${label}: (none)`;
          return `${label}:\n${entries
            .map((rule) => `  ${rule.tool} ${rule.argsPattern ?? "*"} -> ${rule.decision}`)
            .join("\n")}`;
        };
        return {
          kind: "text",
          text: `${format("project", rules.project)}\n${format("global", rules.global)}`,
        };
      }

      if (command.name === "mcp" && services.getMcpStatus) {
        if (command.args) return { kind: "text", text: "usage: /mcp" };
        const statuses = services.getMcpStatus(context.sessionId);
        if (statuses.length === 0) {
          return { kind: "text", text: "No MCP servers configured." };
        }
        const lines: string[] = [];
        for (const status of statuses) {
          lines.push(
            `${status.name} — ${status.state}${status.state === "connected" ? ` (${status.toolCount} tools)` : ""}`,
          );
          if (status.state === "connected") {
            for (const tool of status.toolNames) lines.push(`    ${tool}`);
          } else if (status.error) {
            lines.push(`    error: ${status.error}`);
          }
        }
        return { kind: "text", text: lines.join("\n") };
      }

      if (command.name === "maxloops" && services.getMaxLoops && services.setMaxLoops) {
        const arg = command.args.toLowerCase();
        if (!arg) {
          const current = services.getMaxLoops(context.sessionId);
          return {
            kind: "text",
            text: `model-round limit: ${Number.isFinite(current) ? current : "unlimited"}`,
          };
        }
        const value = arg === "unlimited" || arg === "off" ? 0 : Number(arg);
        if (!Number.isInteger(value) || value < 0) {
          return {
            kind: "text",
            text: `invalid limit '${arg}' — use a positive integer or 'unlimited'`,
          };
        }
        const resolved = value === 0 ? Number.POSITIVE_INFINITY : value;
        services.setMaxLoops(context.sessionId, resolved);
        return {
          kind: "text",
          text: value === 0 ? "model-round limit: unlimited" : `model-round limit: ${value}`,
        };
      }

      if (command.name === "learn" && services.learnPlaybookForSession) {
        const learn = services.learnPlaybookForSession(context.sessionId);
        const tokens = command.args.toLowerCase().split(/\s+/).filter(Boolean);
        const action = tokens[0] ?? "draft";
        if (action === "draft") {
          return { kind: "text", text: await learn.propose(context.signal) };
        }
        if (action === "status") {
          return { kind: "text", text: learn.status() };
        }
        if (action === "discard") {
          return { kind: "text", text: learn.discard() };
        }
        if (action === "save") {
          const scope = tokens[1];
          if (scope !== "project" && scope !== "global") {
            return { kind: "text", text: "usage: /learn save project|global" };
          }
          return { kind: "text", text: await learn.save(scope) };
        }
        return {
          kind: "text",
          text: "usage: /learn [draft|status|discard|save project|save global]",
        };
      }

      if (command.name === "rewind" && services.getCheckpoints && services.rewindToCheckpoint) {
        const checkpoints = services.getCheckpoints(context.sessionId);
        if (!command.args) {
          if (checkpoints.length === 0) {
            return { kind: "text", text: "nothing to rewind to" };
          }
          return {
            kind: "text",
            text: checkpoints
              .map((checkpoint) => `${checkpoint.turnNumber}  ${checkpoint.userInput}`)
              .join("\n"),
          };
        }
        const turnNumber = Number(command.args);
        const known =
          Number.isInteger(turnNumber) &&
          checkpoints.some((checkpoint) => checkpoint.turnNumber === turnNumber);
        if (!known) {
          const available =
            checkpoints.map((checkpoint) => checkpoint.turnNumber).join(", ") || "none";
          return {
            kind: "text",
            text: `no checkpoint #${command.args} (available: ${available})`,
          };
        }
        const rewound = await services.rewindToCheckpoint(context.sessionId, turnNumber);
        return rewound
          ? { kind: "text", text: `rewound to checkpoint #${turnNumber}` }
          : { kind: "text", text: `checkpoint #${turnNumber} is no longer available` };
      }

      if (command.name === "insights" && services.runInsights) {
        return {
          kind: "text",
          text: await services.runInsights(context.sessionId, command.args, context.signal),
        };
      }

      if (command.name === "review" && services.runReview) {
        const status = await services.runReview(context.sessionId, command.args, context.signal);
        return status ? { kind: "text", text: status } : { kind: "handled" };
      }

      if (command.name === "index" && services.runIndex) {
        return {
          kind: "text",
          text: await services.runIndex(context.sessionId, command.args, context.signal),
        };
      }

      return null;
    },
  };
}
