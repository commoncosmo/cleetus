import { tokenizePathArgs } from "../agent/attachments";
import { EFFORTS, type EffortLevel, resolveEffortName } from "../agent/effort";
import { PERSONALITIES, type PersonalityId, resolvePersonalityName } from "../agent/personalities";
import { PERSONAS, type PersonaId, resolvePersonaName } from "../agent/personas";
import { ROUTE_MODES, type RouteMode, resolveRouteName } from "../agent/route-modes";
import type { SessionPreview } from "../agent/session-preview";
import type { LearnPlaybookController } from "../learn/service";
import type { McpServerStatus } from "../mcp/types";
import type { MemoryStore } from "../memory/store";
import { MODES, type PermissionMode, modeInfo, resolveModeName } from "../permission/modes";
import { persistRule } from "../permission/persist";
import type { PermissionRules } from "../permission/types";
import { fetchCatalog, formatCatalog, resolveModelChoice } from "../providers/catalog";
import type { ProviderRegistry } from "../providers/registry";
import { composeSkillTurn } from "../skills/compose";
import type { SkillRegistry } from "../skills/registry";
import type { Skill } from "../skills/types";
import type { WorkflowCommandController } from "../workflows/interactive-controller";
import type { JsonObject, JsonSchema } from "../workflows/types";
import type { SlashCommand } from "./types";

export interface ScopedEditorHost {
  prepare(scope?: "project" | "global" | "cleetus"): Promise<string> | string;
  reload(): Promise<string>;
}

export interface CommandDeps {
  providers: ProviderRegistry;
  getActive: () => { provider: string; model: string };
  setActive: (provider: string, model: string) => void;
  getPermissions: () => PermissionRules;
  getInstructions?: () => string;
  configEditor?: ScopedEditorHost;
  permissionsEditor?: ScopedEditorHost;
  instructionsEditor?: ScopedEditorHost;
  globalPermissionsPath?: string;
  projectPermissionsPath?: string;
  onClear?: () => void;
  onExit?: () => void;
  onShowModels?: () => void;
  /** Current permission mode (for `/mode` with no args / display). */
  getMode?: () => PermissionMode;
  /** Apply a non-dangerous mode immediately (used for `normal`). */
  setMode?: (mode: PermissionMode) => void;
  /** Open the interactive mode picker; pass a target to jump straight to it. */
  onShowMode?: (initial?: PermissionMode) => void;
  /** MCP server status for the read-only `/mcp` command. Omit to hide the command. */
  getMcpStatus?: () => McpServerStatus[];
  /** Run the code indexer. Omit to hide the `/index` command. */
  runIndex?: (args: string, print: (s: string) => void) => Promise<void>;
  /** Run the insights analyzer for `/insights`. Omit to hide the command. */
  runInsights?: (args: string, print: (s: string) => void) => Promise<void>;
  /** Run the adversarial reviewer for `/review`. Omit to hide the command. */
  runReview?: (args: string, print: (s: string) => void) => Promise<void>;
  /** Build the seeded turn for `/spec` (or undefined when the spec-creator skill is missing).
   *  Omit the whole dep to hide the command. */
  buildSpecSeed?: (idea: string) => string | undefined;
  /** Memory stores for the `/memory` command. Omit to hide it. */
  memory?: { global: MemoryStore; project: MemoryStore };
  /** Current routing mode (for `/route` with no args / display). Omit to hide the command. */
  getRouteMode?: () => RouteMode;
  /** Apply a routing mode immediately. */
  setRouteMode?: (mode: RouteMode) => void;
  /** Open the interactive route picker (TUI). */
  onShowRoute?: () => void;
  /** Current persona (for `/persona` with no args / display). Omit to hide the command. */
  getPersona?: () => PersonaId;
  /** Apply a persona immediately. */
  setPersona?: (id: PersonaId) => void;
  /** Open the interactive persona picker (TUI). */
  onShowPersona?: () => void;
  /** True when config `system_prompt_file` replaces the persona text; `/persona` output
   *  notes it so switching personas is visibly a no-op on the prompt. */
  systemPromptOverridden?: boolean;
  /** Current reasoning effort (for `/effort` with no args / display). Omit to hide the command. */
  getEffort?: () => EffortLevel;
  /** Apply an effort level immediately. */
  setEffort?: (level: EffortLevel) => void;
  /** Open the interactive effort picker (TUI). */
  onShowEffort?: () => void;
  /** Current personality (for `/personality` with no args / display). Omit to hide the command. */
  getPersonality?: () => PersonalityId;
  /** Apply a personality immediately. */
  setPersonality?: (id: PersonalityId) => void;
  /** Open the interactive personality picker (TUI). */
  onShowPersonality?: () => void;
  /** Configured tiers, or undefined when none are set. */
  getTiers?: () =>
    | { small: { provider: string; model: string }; large: { provider: string; model: string } }
    | undefined;
  /** The tier used by the most recent model call (for status display). */
  getLastTier?: () => "small" | "large" | null;
  /** The router's reason for the last decision (e.g. `smart: escalated (broad_code)`), shown
   * alongside the tier in `/route`'s no-arg status output. */
  getLastReason?: () => string | null;
  /** Skill registry for the `/skill` command. Omit to hide the command. */
  getSkills?: () => SkillRegistry;
  /** Resolve and security-check the exact user skill source before opening it. */
  prepareSkillEditorTarget?: (skill: Skill) => string;
  /** Rediscover and activate one edited user skill without restarting the TUI. */
  reloadSkill?: (
    name: string,
    expectedFilePath: string,
  ) => Promise<{ skill?: Skill; warnings: string[] }>;
  /** Draft and explicitly persist learned playbooks from the preceding completed turn. */
  learnPlaybook?: LearnPlaybookController;
  /** Shared strict-workflow command controller. Omit to hide `/workflow`. */
  workflowController?: WorkflowCommandController;
  collectWorkflowInputs?: (request: {
    workflow: string;
    schema: JsonSchema;
  }) => Promise<JsonObject>;
  /** Live checkpoints for `/rewind` (newest-last). Omit to hide the command. */
  getCheckpoints?: () => { turnNumber: number; userInput: string; ts: number }[];
  /** Rewind files + conversation to the given checkpoint turn number. */
  rewindToCheckpoint?: (turnNumber: number) => Promise<void>;
  /** Open the interactive rewind picker (TUI). */
  onShowRewind?: () => void;
  /** Branch a new session from the current one: snapshot, create, copy. Returns the new
   *  session id, or null when there is nothing to fork yet. Omit to hide the command. */
  forkSession?: () => { id: string } | null;
  /** Project sessions, newest first, for `/sessions`. */
  getSessions?: () => SessionPreview[];
  /** Active session id, marked in `/sessions`. */
  getSessionId?: () => string;
  /** Force-compact the active session's context now. Omit to hide `/compact`. */
  compactSession?: (instruction?: string) => Promise<{
    compacted: boolean;
    messagesFolded: number;
    beforeTokens: number;
    afterTokens: number;
    partial: boolean;
  }>;
  /** Read the session orchestration toggle (undefined when orchestration isn't wired). */
  getOrchestrationEnabled?: () => boolean;
  /** Flip the session orchestration toggle. */
  setOrchestrationEnabled?: (enabled: boolean) => void;
  /** Current tool-call limit (Infinity = unlimited); omit to hide `/maxloops`. */
  getMaxLoops?: () => number;
  /** Set the tool-call limit for the rest of the session (0 = unlimited). */
  setMaxLoops?: (n: number) => void;
  /** Stage image paths for the next message (TUI attachment buffer). Omit to hide `/image`. */
  stageImagePaths?: (paths: string[]) => Promise<void>;
  /** Clear the staged-image buffer. */
  clearStagedImages?: () => void;
  /** Grab an image off the OS clipboard and stage it. */
  stageClipboardImage?: () => Promise<void>;
}

function formatKTokens(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

export class CommandRegistry {
  private cmds: Map<string, SlashCommand> = new Map();
  private aliases: Map<string, string> = new Map();
  register(cmd: SlashCommand): void {
    this.cmds.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) this.aliases.set(alias, cmd.name);
  }
  get(name: string): SlashCommand | undefined {
    const direct = this.cmds.get(name);
    if (direct) return direct;
    const canonical = this.aliases.get(name);
    return canonical ? this.cmds.get(canonical) : undefined;
  }
  all(): SlashCommand[] {
    return [...this.cmds.values()];
  }
}

export function buildCommandRegistry(deps: CommandDeps): CommandRegistry {
  const reg = new CommandRegistry();

  if (deps.workflowController) {
    reg.register({
      name: "workflow",
      description: "Create, inspect, validate, run, test, or view strict workflows",
      takesArgs: true,
      run: (args, ctx) =>
        deps.workflowController!.handle(args, {
          print: ctx.print,
          signal: ctx.signal,
          sessionId: deps.getSessionId?.(),
          collectInputs: deps.collectWorkflowInputs,
          openEditor: ctx.openEditor
            ? (request) => ctx.openEditor!({ targets: request.targets })
            : undefined,
        }),
    });
  }

  reg.register({
    name: "help",
    description: "List available commands",
    run: async (_args, ctx) => {
      const lines = reg.all().map((c) => {
        const aliases = c.aliases?.length
          ? ` (alias: ${c.aliases.map((a) => `/${a}`).join(", ")})`
          : "";
        return `/${c.name.padEnd(12)} ${c.description}${aliases}`;
      });
      ctx.print(lines.join("\n"));
    },
  });

  reg.register({
    name: "edit",
    description: "Open files or directories in $EDITOR, or create one project file",
    takesArgs: true,
    argsOptional: true,
    run: async (args, ctx) => {
      if (!ctx.openEditor) {
        throw new Error("editor handoff is unavailable in this host");
      }
      const trimmed = args.trim();
      const create = trimmed === "--create" || trimmed.startsWith("--create ");
      const outside = trimmed === "--outside-project" || trimmed.startsWith("--outside-project ");
      if (
        (create && trimmed.slice("--create".length).trimStart().startsWith("--outside-project")) ||
        (outside && trimmed.slice("--outside-project".length).trimStart().startsWith("--create"))
      ) {
        throw new Error("/edit --create cannot be combined with --outside-project");
      }
      const editorArgs = create
        ? trimmed.slice("--create".length).trimStart()
        : outside
          ? trimmed.slice("--outside-project".length).trimStart()
          : args;
      if (create && !editorArgs.trim()) {
        throw new Error("usage: /edit --create <project-file>");
      }
      if (outside && !editorArgs.trim()) {
        throw new Error("usage: /edit --outside-project <path ...>");
      }
      await ctx.openEditor({
        args: editorArgs,
        ...(outside ? { confirmOutsideProject: true } : {}),
        ...(create ? { create: true } : {}),
      });
    },
  });

  reg.register({
    name: "provider",
    description: "Switch active provider, or list providers",
    takesArgs: true,
    run: async (args, ctx) => {
      const arg = args.trim();
      if (!arg) {
        const active = deps.getActive();
        ctx.print(
          deps.providers
            .names()
            .map((n) => `${n === active.provider ? "* " : "  "}${n}`)
            .join("\n"),
        );
        return;
      }
      deps.providers.get(arg);
      const cur = deps.getActive();
      deps.setActive(arg, cur.model);
      ctx.print(`active provider: ${arg}`);
    },
  });

  reg.register({
    name: "model",
    description: "Switch the active model, or open the picker (no args)",
    takesArgs: true,
    run: async (args, ctx) => {
      const cur = deps.getActive();
      const arg = args.trim();
      // No args: open the interactive picker when available (TUI); otherwise
      // print the active model (non-TUI / one-shot).
      if (!arg) {
        if (deps.onShowModels) {
          deps.onShowModels();
          return;
        }
        ctx.print(`active model: ${cur.model}`);
        return;
      }
      const catalog = await fetchCatalog(deps.providers);
      const res = resolveModelChoice(catalog, arg);
      if (res.kind === "ambiguous") {
        ctx.print(
          `model '${res.model}' exists on multiple providers: ${res.providers.join(", ")}. use /model <provider> <model>`,
        );
        return;
      }
      if (res.kind === "not-found") {
        ctx.print(`model '${arg}' not found. available:\n${formatCatalog(catalog)}`);
        return;
      }
      deps.setActive(res.provider, res.model);
      const multi = catalog.length > 1;
      ctx.print(`active model: ${res.model}${multi ? ` (provider: ${res.provider})` : ""}`);
    },
  });

  reg.register({
    name: "mode",
    description: "Switch permission mode (`normal` / `fuckit` / `plan`), or open the picker",
    takesArgs: true,
    run: async (args, ctx) => {
      const arg = args.trim();
      // Bare /mode opens the interactive picker when available (TUI); otherwise
      // it prints the current mode and the available options.
      if (!arg) {
        if (deps.onShowMode) {
          deps.onShowMode();
          return;
        }
        const cur = deps.getMode?.() ?? "normal";
        const lines = MODES.map((m) => `${m.id === cur ? "* " : "  "}${m.id} — ${m.description}`);
        ctx.print(lines.join("\n"));
        return;
      }
      const mode = resolveModeName(arg);
      if (!mode) {
        ctx.print(`unknown mode '${arg}'. available: ${MODES.map((m) => m.id).join(", ")}`);
        return;
      }
      // Dangerous modes always route through the picker's confirmation step.
      if (modeInfo(mode).dangerous) {
        if (deps.onShowMode) {
          deps.onShowMode(mode);
          return;
        }
        ctx.print(`'${mode}' must be enabled from the interactive picker`);
        return;
      }
      deps.setMode?.(mode);
      ctx.print(`permission mode: ${mode}`);
    },
  });

  if (deps.setMode) {
    reg.register({
      name: "plan",
      description: "Enter plan mode: investigate read-only and propose a plan before editing",
      takesArgs: true,
      argsOptional: true,
      run: async (args, ctx) => {
        const trimmed = args.trim();
        if (trimmed === "edit" || trimmed.startsWith("edit ")) {
          if (!ctx.editArtifact) {
            ctx.print("plan artifact editing is unavailable in this host");
            return;
          }
          ctx.print(await ctx.editArtifact("plan", trimmed.slice(4).trim()));
          return;
        }
        if (trimmed) {
          ctx.print("usage: /plan [edit [path]]");
          return;
        }
        deps.setMode!("plan");
        ctx.print("plan mode: investigate and propose a plan; mutating tools are disabled");
      },
    });
  }

  if (deps.setOrchestrationEnabled) {
    reg.register({
      name: "orchestrate",
      description: "Toggle orchestration for this session (`on` / `off` / `toggle`)",
      takesArgs: true,
      run: async (args, ctx) => {
        const cur = deps.getOrchestrationEnabled?.() ?? false;
        const a = args.trim().toLowerCase();
        if (a === "") {
          ctx.print(`orchestration: ${cur ? "on" : "off"}`);
          return;
        }
        let next: boolean;
        if (a === "on") next = true;
        else if (a === "off") next = false;
        else if (a === "toggle") next = !cur;
        else {
          ctx.print("usage: /orchestrate [on|off|toggle]");
          return;
        }
        deps.setOrchestrationEnabled!(next);
        ctx.print(`orchestration: ${next ? "on" : "off"}`);
      },
    });
  }

  reg.register({
    name: "permissions",
    description: "Show permission rules or edit project/global rules",
    takesArgs: true,
    argsOptional: true,
    run: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "edit" || trimmed.startsWith("edit ")) {
        if (!deps.permissionsEditor || !ctx.openEditor) {
          ctx.print("permission editing is unavailable in this host");
          return;
        }
        const scope = trimmed.slice(4).trim() || "project";
        if (scope !== "project" && scope !== "global") {
          ctx.print("usage: /permissions edit [project|global]");
          return;
        }
        const target = await deps.permissionsEditor.prepare(scope);
        await ctx.openEditor({ targets: [target] });
        ctx.print(await deps.permissionsEditor.reload());
        return;
      }
      if (trimmed) {
        ctx.print("usage: /permissions [edit [project|global]]");
        return;
      }
      const r = deps.getPermissions();
      const fmt = (label: string, rules: typeof r.project) => {
        if (!rules.length) return `${label}: (none)`;
        const lines = rules.map(
          (rule) => `  ${rule.tool} ${rule.argsPattern ?? "*"} -> ${rule.decision}`,
        );
        return `${label}:\n${lines.join("\n")}`;
      };
      ctx.print(`${fmt("project", r.project)}\n${fmt("global", r.global)}`);
    },
  });

  const persistDecision =
    (decision: "allow" | "deny") => async (args: string, ctx: { print: (s: string) => void }) => {
      const arg = args.trim();
      if (!arg) {
        ctx.print(`usage: /${decision} <tool>:<args_pattern>`);
        return;
      }
      const colon = arg.indexOf(":");
      const tool = colon === -1 ? arg : arg.slice(0, colon);
      const argsPattern = colon === -1 ? undefined : arg.slice(colon + 1);
      const target = deps.projectPermissionsPath;
      if (!target) {
        ctx.print("no project permissions path configured");
        return;
      }
      await persistRule(target, { tool, argsPattern, decision });
      deps.getPermissions().project.push({ tool, argsPattern, decision });
      ctx.print(`added ${decision} rule for ${tool}${argsPattern ? `:${argsPattern}` : ""}`);
    };

  reg.register({
    name: "allow",
    description: "Add an allow rule (project): `tool:pattern`",
    takesArgs: true,
    run: persistDecision("allow"),
  });
  reg.register({
    name: "deny",
    description: "Add a deny rule (project): `tool:pattern`",
    takesArgs: true,
    run: persistDecision("deny"),
  });

  reg.register({
    name: "instructions",
    description: "Show resolved instructions or edit an instruction source",
    takesArgs: true,
    argsOptional: true,
    run: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "edit" || trimmed.startsWith("edit ")) {
        if (!deps.instructionsEditor || !ctx.openEditor) {
          ctx.print("instruction editing is unavailable in this host");
          return;
        }
        const requested = trimmed.slice(4).trim();
        if (
          requested &&
          requested !== "project" &&
          requested !== "global" &&
          requested !== "cleetus"
        ) {
          ctx.print("usage: /instructions edit [project|global|cleetus]");
          return;
        }
        const target = await deps.instructionsEditor.prepare(
          requested ? (requested as "project" | "global" | "cleetus") : undefined,
        );
        await ctx.openEditor({ targets: [target] });
        ctx.print(await deps.instructionsEditor.reload());
        return;
      }
      if (trimmed) {
        ctx.print("usage: /instructions [edit [project|global|cleetus]]");
        return;
      }
      const text = deps.getInstructions?.() ?? "";
      ctx.print(text.trim().length ? text : "(no instruction files found)");
    },
  });

  if (deps.configEditor) {
    reg.register({
      name: "config",
      description: "Edit and validate project/global configuration",
      takesArgs: true,
      argsOptional: true,
      run: async (args, ctx) => {
        const tokens = args.trim().split(/\s+/u).filter(Boolean);
        if (tokens[0] !== "edit" || tokens.length > 2) {
          ctx.print("usage: /config edit [project|global]");
          return;
        }
        const scope = tokens[1] ?? "project";
        if (scope !== "project" && scope !== "global") {
          ctx.print("usage: /config edit [project|global]");
          return;
        }
        if (!ctx.openEditor) {
          ctx.print("configuration editing is unavailable in this host");
          return;
        }
        const target = await deps.configEditor!.prepare(scope);
        await ctx.openEditor({ targets: [target] });
        ctx.print(await deps.configEditor!.reload());
      },
    });
  }

  reg.register({
    name: "clear",
    description: "Clear conversation context (keeps session id)",
    run: async (_args, ctx) => {
      deps.onClear?.();
      ctx.print("context cleared");
    },
  });

  if (deps.getSessions && deps.getSessionId) {
    reg.register({
      name: "sessions",
      aliases: ["session"],
      description: "List project session IDs and mark the active session",
      run: (_args, ctx) => {
        const active = deps.getSessionId!();
        const sessions = deps.getSessions!();
        if (sessions.length === 0) {
          ctx.print("No sessions found in this project.");
          return;
        }
        ctx.print(
          [
            "Project sessions (newest first):",
            ...sessions.map(
              (session) =>
                `${session.id === active ? "* " : "  "}${session.id} · ${session.model} · ${session.preview || "(no messages)"}`,
            ),
            "Resume one with: cleetus --resume <session-id>",
          ].join("\n"),
        );
      },
    });
  }

  reg.register({
    name: "exit",
    description: "Quit",
    aliases: ["quit"],
    run: async (_args) => {
      deps.onExit?.();
    },
  });

  if (deps.getMcpStatus) {
    reg.register({
      name: "mcp",
      description: "List MCP servers and their tools",
      run: (_args, ctx) => {
        const statuses = deps.getMcpStatus!();
        if (statuses.length === 0) {
          ctx.print("No MCP servers configured.");
          return;
        }
        const lines: string[] = [];
        for (const s of statuses) {
          lines.push(
            `${s.name} — ${s.state}${s.state === "connected" ? ` (${s.toolCount} tools)` : ""}`,
          );
          if (s.state === "connected") {
            for (const t of s.toolNames) lines.push(`    ${t}`);
          } else if (s.error) {
            lines.push(`    error: ${s.error}`);
          }
        }
        ctx.print(lines.join("\n"));
      },
    });
  }

  if (deps.runIndex) {
    reg.register({
      name: "index",
      description: "Index the codebase for semantic search (`rebuild` forces a full rebuild)",
      takesArgs: true,
      run: async (args, ctx) => {
        await deps.runIndex!(args.trim(), ctx.print);
      },
    });
  }

  if (deps.runInsights) {
    reg.register({
      name: "insights",
      description: "Analyze session history (`since 7d`, `explain` for an LLM narrative)",
      takesArgs: true,
      aliases: ["analyze"],
      run: async (args, ctx) => {
        await deps.runInsights!(args.trim(), ctx.print);
      },
    });
  }

  if (deps.runReview) {
    reg.register({
      name: "review",
      description: "Adversarially review your changes (working-tree diff; optional paths or ref)",
      takesArgs: true,
      run: async (args, ctx) => {
        await deps.runReview!(args.trim(), ctx.print);
      },
    });
  }

  if (deps.memory) {
    const mem = deps.memory;
    reg.register({
      name: "memory",
      description: "List remembered facts; `forget <n>` to remove, `add <text>` to add (project)",
      takesArgs: true,
      run: async (args, ctx) => {
        const trimmed = args.trim();
        const sub = trimmed.split(/\s+/)[0] ?? "";
        const rest = trimmed.slice(sub.length).trim();

        if (sub === "forget") {
          const n = Number(rest);
          if (!Number.isInteger(n) || n < 1) {
            ctx.print("usage: /memory forget <number>");
            return;
          }
          const globals = mem.global.list();
          const projects = mem.project.list();
          if (n <= globals.length) {
            mem.global.removeAt(n - 1);
            ctx.print(`forgot (global) ${n}: ${globals[n - 1]}`);
          } else if (n <= globals.length + projects.length) {
            const localIdx = n - globals.length - 1;
            mem.project.removeAt(localIdx);
            ctx.print(`forgot (project) ${n}: ${projects[localIdx]}`);
          } else {
            ctx.print(`no memory numbered ${n}`);
          }
          return;
        }

        if (sub === "add") {
          if (!rest) {
            ctx.print("usage: /memory add <text>");
            return;
          }
          mem.project.add(rest);
          ctx.print(`remembered (project) → ${mem.project.path}: ${rest}`);
          return;
        }

        // list (bare or "list")
        const globals = mem.global.list();
        const projects = mem.project.list();
        if (globals.length === 0 && projects.length === 0) {
          ctx.print("no memories yet");
          return;
        }
        const lines: string[] = [];
        let n = 1;
        if (globals.length > 0) {
          lines.push("Global:");
          for (const m of globals) lines.push(`  ${n++}. ${m}`);
        }
        if (projects.length > 0) {
          lines.push("Project:");
          for (const m of projects) lines.push(`  ${n++}. ${m}`);
        }
        ctx.print(lines.join("\n"));
      },
    });
  }

  if (deps.getRouteMode && deps.setRouteMode) {
    reg.register({
      name: "route",
      description: "Switch model routing mode (`manual` / `speed` / `smart`), or show status",
      takesArgs: true,
      run: async (args, ctx) => {
        const arg = args.trim();
        if (!arg) {
          if (deps.onShowRoute) {
            deps.onShowRoute();
            return;
          }
          const cur = deps.getRouteMode!();
          const tiers = deps.getTiers?.();
          const lines = ROUTE_MODES.map(
            (m) => `${m.id === cur ? "* " : "  "}${m.id} — ${m.description}`,
          );
          lines.push("");
          lines.push(
            tiers
              ? `tiers: small=${tiers.small.model} large=${tiers.large.model}`
              : "tiers: (none configured — speed/smart unavailable)",
          );
          const last = deps.getLastTier?.();
          if (last) {
            const lastReason = deps.getLastReason?.();
            lines.push(
              lastReason ? `last call: ${last} tier — ${lastReason}` : `last call: ${last} tier`,
            );
          }
          ctx.print(lines.join("\n"));
          return;
        }
        const mode = resolveRouteName(arg);
        if (!mode) {
          ctx.print(
            `unknown route mode '${arg}'. available: ${ROUTE_MODES.map((m) => m.id).join(", ")}`,
          );
          return;
        }
        if ((mode === "speed" || mode === "smart") && !deps.getTiers?.()) {
          ctx.print(`'${mode}' needs routing.tiers configured in config.yaml`);
          return;
        }
        deps.setRouteMode!(mode);
        ctx.print(`routing mode: ${mode}`);
      },
    });
  }

  if (deps.getPersona && deps.setPersona) {
    reg.register({
      name: "persona",
      description:
        "Switch the system-prompt persona (`coding` / `chat` / `concise` / `general`), or show status",
      takesArgs: true,
      run: async (args, ctx) => {
        const overrideNote = deps.systemPromptOverridden
          ? "\nnote: system_prompt_file override active — persona text is replaced"
          : "";
        const arg = args.trim();
        if (!arg) {
          if (deps.onShowPersona) {
            deps.onShowPersona();
            return;
          }
          const cur = deps.getPersona!();
          ctx.print(
            PERSONAS.map((p) => `${p.id === cur ? "* " : "  "}${p.id} — ${p.description}`).join(
              "\n",
            ) + overrideNote,
          );
          return;
        }
        const id = resolvePersonaName(arg);
        if (!id) {
          ctx.print(`unknown persona '${arg}'. available: ${PERSONAS.map((p) => p.id).join(", ")}`);
          return;
        }
        deps.setPersona!(id);
        ctx.print(`persona: ${id}${overrideNote}`);
      },
    });
  }

  if (deps.getEffort && deps.setEffort) {
    reg.register({
      name: "effort",
      description: "Switch reasoning effort (`low` / `medium` / `high`), or show status",
      takesArgs: true,
      run: async (args, ctx) => {
        const arg = args.trim();
        if (!arg) {
          if (deps.onShowEffort) {
            deps.onShowEffort();
            return;
          }
          const cur = deps.getEffort!();
          ctx.print(
            EFFORTS.map((e) => `${e.id === cur ? "* " : "  "}${e.id} — ${e.description}`).join(
              "\n",
            ),
          );
          return;
        }
        const level = resolveEffortName(arg);
        if (!level) {
          ctx.print(`unknown effort '${arg}'. available: ${EFFORTS.map((e) => e.id).join(", ")}`);
          return;
        }
        deps.setEffort!(level);
        ctx.print(`effort: ${level}`);
      },
    });
  }

  if (deps.setMaxLoops) {
    reg.register({
      name: "maxloops",
      description: "Set the session's per-turn round limit (`unlimited` or a number)",
      takesArgs: true,
      run: async (args, ctx) => {
        const arg = args.trim().toLowerCase();
        if (!arg) {
          const cur = deps.getMaxLoops?.();
          ctx.print(
            cur === undefined
              ? "model-round limit unavailable"
              : `model-round limit: ${Number.isFinite(cur) ? cur : "unlimited"}`,
          );
          return;
        }
        const n = arg === "unlimited" || arg === "off" ? 0 : Number(arg);
        if (!Number.isInteger(n) || n < 0) {
          ctx.print(`invalid limit '${arg}' — use a positive integer or 'unlimited'`);
          return;
        }
        deps.setMaxLoops!(n);
        ctx.print(n === 0 ? "model-round limit: unlimited" : `model-round limit: ${n}`);
      },
    });
  }

  if (deps.getCheckpoints && deps.rewindToCheckpoint) {
    reg.register({
      name: "rewind",
      description: "Undo a turn: restore files + conversation to a checkpoint",
      takesArgs: true,
      run: async (args, ctx) => {
        const arg = args.trim();
        const cps = deps.getCheckpoints!();
        if (!arg) {
          if (cps.length === 0) {
            ctx.print("nothing to rewind to");
            return;
          }
          if (deps.onShowRewind) {
            deps.onShowRewind();
            return;
          }
          ctx.print(cps.map((c) => `${c.turnNumber}  ${c.userInput}`).join("\n"));
          return;
        }
        // Number() (not parseInt) so "2.5"/"2abc" are rejected rather than truncated to 2.
        const n = Number(arg);
        const known = Number.isInteger(n) && cps.some((c) => c.turnNumber === n);
        if (!known) {
          const avail = cps.map((c) => c.turnNumber).join(", ") || "none";
          ctx.print(`no checkpoint #${arg} (available: ${avail})`);
          return;
        }
        await deps.rewindToCheckpoint!(n);
        // The TUI also renders a turn_reverted marker, but print a confirmation so
        // non-interactive callers get feedback for this irreversible action.
        ctx.print(`rewound to checkpoint #${n}`);
      },
    });
  }

  if (deps.forkSession) {
    reg.register({
      name: "fork",
      description: "Branch a new session from the current one (resume it with --resume <id>)",
      run: (_args, ctx) => {
        const forked = deps.forkSession?.();
        if (!forked) {
          ctx.print("nothing to fork yet — send a message first");
          return;
        }
        ctx.print(`forked → ${forked.id}\nresume it with:  cleetus --resume ${forked.id}`);
      },
    });
  }

  if (deps.stageImagePaths) {
    reg.register({
      name: "image",
      description:
        "attach image(s) to your next message; `/image clear` resets; `/image` alone grabs the clipboard",
      takesArgs: true,
      argsOptional: true,
      run: async (args, ctx) => {
        const a = args.trim();
        if (a === "clear") {
          deps.clearStagedImages?.();
          ctx.print("cleared staged images");
          return;
        }
        if (a.length === 0) {
          await deps.stageClipboardImage?.();
          return;
        }
        await deps.stageImagePaths?.(tokenizePathArgs(a));
      },
    });
  }

  if (deps.compactSession) {
    reg.register({
      name: "compact",
      description: "Summarize the conversation so far to shrink the context window",
      takesArgs: true,
      run: async (args, ctx) => {
        const instruction = args.trim() || undefined;
        const r = await deps.compactSession!(instruction);
        if (!r.compacted) {
          ctx.print("Nothing to compact yet — context is already small.");
          return;
        }
        const pct = Math.round((1 - r.afterTokens / Math.max(1, r.beforeTokens)) * 100);
        const plural = r.messagesFolded === 1 ? "" : "s";
        const partialNote = r.partial ? " (partial summary — summarizer was degraded.)" : "";
        ctx.print(
          `Compacted ${r.messagesFolded} message${plural}: ~${formatKTokens(r.beforeTokens)} → ~${formatKTokens(r.afterTokens)} tokens (-${pct}%).${partialNote}`,
        );
      },
    });
  }

  if (deps.getSkills) {
    reg.register({
      name: "skill",
      description: "Run or edit a skill playbook, or list available skills",
      takesArgs: true,
      run: async (args, ctx) => {
        const registry = deps.getSkills!();
        const trimmed = args.trim();
        if (!trimmed) {
          const lines = registry
            .list()
            .map((s) => `${s.source === "built-in" ? "  " : "* "}${s.name} — ${s.description}`);
          ctx.print([...lines, "type /skill <name> to run one"].join("\n"));
          return;
        }
        const firstSpace = trimmed.indexOf(" ");
        const first = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
        const afterFirst = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
        const action = first === "edit" || first === "run" ? first : "run";
        const invocation = action === "run" && first !== "run" ? trimmed : afterFirst;
        if (!invocation) {
          ctx.print(`usage: /skill ${action} <name>${action === "run" ? " [args]" : ""}`);
          return;
        }
        const sp = invocation.indexOf(" ");
        const nameArg = sp === -1 ? invocation : invocation.slice(0, sp);
        const rest = sp === -1 ? "" : invocation.slice(sp + 1);
        const name = registry.resolveName(nameArg);
        if (!name) {
          const avail = registry
            .list()
            .map((s) => s.name)
            .join(", ");
          ctx.print(`unknown skill '${nameArg}'. available: ${avail}`);
          return;
        }
        if (action === "edit") {
          const skill = registry.get(name)!;
          if (!skill.filePath) {
            ctx.print(
              `skill '${name}' is built in and has no editable source file; create a project or global override first`,
            );
            return;
          }
          if (!ctx.openEditor) {
            ctx.print("skill editing is unavailable in this host");
            return;
          }
          const target = deps.prepareSkillEditorTarget
            ? deps.prepareSkillEditorTarget(skill)
            : (skill.baseDir ?? skill.filePath);
          await ctx.openEditor({ targets: [target] });
          if (!deps.reloadSkill) {
            ctx.print(`Edited ${target}. Restart Cleetus to reload the skill.`);
            return;
          }
          const reloaded = await deps.reloadSkill(name, skill.filePath);
          if (!reloaded.skill || reloaded.skill.source === "built-in") {
            ctx.print(
              `Edited ${target}, but skill '${name}' no longer parses as an active user skill. The previous in-memory version remains active.`,
            );
            return;
          }
          const warningText = reloaded.warnings.length
            ? `\nWarnings:\n${reloaded.warnings.map((warning) => `- ${warning}`).join("\n")}`
            : "";
          ctx.print(
            `Reloaded ${reloaded.skill.source} skill '${name}' from ${reloaded.skill.baseDir ?? reloaded.skill.filePath}.${warningText}`,
          );
          return;
        }
        if (name === "workflow-creator") {
          if (!deps.workflowController) {
            ctx.print("workflow creation is unavailable in this host");
            return;
          }
          await deps.workflowController.handle(`create${rest.trim() ? ` ${rest.trim()}` : ""}`, {
            print: ctx.print,
            signal: ctx.signal,
            sessionId: deps.getSessionId?.(),
          });
          return;
        }
        if (!ctx.runPrompt) {
          ctx.print("skills require interactive mode");
          return;
        }
        await ctx.runPrompt(composeSkillTurn(registry.get(name)!, rest));
      },
    });
  }

  if (deps.learnPlaybook) {
    reg.register({
      name: "learn",
      description: "Draft or refine a playbook from the previous turn; save explicitly to adopt",
      takesArgs: true,
      run: async (args, ctx) => {
        const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const action = tokens[0] ?? "draft";
        if (action === "draft") {
          ctx.print(await deps.learnPlaybook!.propose(ctx.signal));
          return;
        }
        if (action === "status") {
          ctx.print(deps.learnPlaybook!.status());
          return;
        }
        if (action === "discard") {
          ctx.print(deps.learnPlaybook!.discard());
          return;
        }
        if (action === "save") {
          const scope = tokens[1];
          if (scope !== "project" && scope !== "global") {
            ctx.print("usage: /learn save project|global");
            return;
          }
          ctx.print(await deps.learnPlaybook!.save(scope));
          return;
        }
        ctx.print("usage: /learn [draft|status|discard|save project|save global]");
      },
    });
  }

  if (deps.buildSpecSeed) {
    reg.register({
      name: "spec",
      description: "Draft a spec interactively (`/spec [rough idea]`)",
      takesArgs: true,
      run: async (args, ctx) => {
        const trimmed = args.trim();
        if (trimmed === "edit" || trimmed.startsWith("edit ")) {
          if (!ctx.editArtifact) {
            ctx.print("spec artifact editing is unavailable in this host");
            return;
          }
          ctx.print(await ctx.editArtifact("spec", trimmed.slice(4).trim()));
          return;
        }
        const seed = deps.buildSpecSeed!(args);
        if (!seed) {
          ctx.print("spec-creator skill is unavailable");
          return;
        }
        if (!ctx.runPrompt) {
          ctx.print("spec creation requires interactive mode");
          return;
        }
        await ctx.runPrompt(seed);
      },
    });
  }

  if (deps.getPersonality && deps.setPersonality) {
    reg.register({
      name: "personality",
      description: "Switch the voice overlay (`neutral` / `cleetus` / `bofh`), or show status",
      takesArgs: true,
      run: async (args, ctx) => {
        const arg = args.trim();
        if (!arg) {
          if (deps.onShowPersonality) {
            deps.onShowPersonality();
            return;
          }
          const cur = deps.getPersonality!();
          ctx.print(
            PERSONALITIES.map(
              (p) => `${p.id === cur ? "* " : "  "}${p.id} — ${p.description}`,
            ).join("\n"),
          );
          return;
        }
        const id = resolvePersonalityName(arg);
        if (!id) {
          ctx.print(
            `unknown personality '${arg}'. available: ${PERSONALITIES.map((p) => p.id).join(", ")}`,
          );
          return;
        }
        deps.setPersonality!(id);
        ctx.print(`personality: ${id}`);
      },
    });
  }

  return reg;
}
