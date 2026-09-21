import { Command } from "commander";

export interface AcpCliOptions {
  provider?: string;
  model?: string;
  route?: string;
  routeSmallProvider?: string;
  routeSmallModel?: string;
  routeLargeProvider?: string;
  routeLargeModel?: string;
  sessionDb?: string;
  persona?: string;
  personality?: string;
  effort?: string;
  instructions?: string;
  configDir?: string;
  projectHome?: string;
  global?: boolean;
  scratch?: boolean;
  inheritProjectInstructions?: boolean;
  inheritProjectMemory?: boolean;
  verbose?: boolean;
}

/** Parse the post-`acp` argv into ACP runtime options. `cleetus acp` is dispatched by an early
 *  `argv[2] === "acp"` branch (not a commander subcommand — see invocation.ts), so it carries its
 *  own small parser. `argv` is the full process argv; the "acp" token at index 2 is dropped. */
export function parseAcpOptions(argv: string[]): AcpCliOptions {
  const acp = new Command()
    .name("cleetus acp")
    .option("--provider <name>", "override provider")
    .option("--model <name>", "override model")
    .option("--route <mode>", "routing mode: manual | speed | smart")
    .option("--route-small-provider <name>", "routing small-tier provider")
    .option("--route-small-model <name>", "routing small-tier model")
    .option("--route-large-provider <name>", "routing large-tier provider")
    .option("--route-large-model <name>", "routing large-tier model")
    .option(
      "--session-db <path>",
      "use a specific session database file (overrides the per-directory default)",
    )
    .option("--persona <id>", "system-prompt persona: coding | chat | concise | general | security")
    .option("--personality <id>", "voice overlay: neutral | cleetus | bofh")
    .option("--effort <level>", "reasoning effort: low | medium | high")
    .option("--instructions <path>", "load a system-prompt instructions file from an explicit path")
    .option("--config-dir <path>", "use a specific config directory (default ~/.config/cleetus)")
    .option(
      "--project-dir <path>",
      "project-home scope anchor (memory/instructions/artifacts), distinct from cwd",
    )
    .option("--global", "operate against the persistent global workspace (default ~/.cleetus)")
    .option("--scratch", "operate against a fresh ephemeral directory, deleted on exit")
    .option(
      "--no-project-instructions",
      "do not inherit the project's instructions in this session",
    )
    .option("--no-project-memory", "do not inherit the project's memory in this session")
    .option("--verbose", "show warning and internal diagnostic notices")
    .allowExcessArguments()
    .allowUnknownOption();
  acp.parse([...argv.slice(0, 2), ...argv.slice(3)]); // keep [exec, exec], drop the "acp" token
  const o = acp.opts<{
    provider?: string;
    model?: string;
    route?: string;
    routeSmallProvider?: string;
    routeSmallModel?: string;
    routeLargeProvider?: string;
    routeLargeModel?: string;
    sessionDb?: string;
    persona?: string;
    personality?: string;
    effort?: string;
    instructions?: string;
    configDir?: string;
    projectDir?: string;
    global?: boolean;
    scratch?: boolean;
    projectInstructions?: boolean;
    projectMemory?: boolean;
    verbose?: boolean;
  }>();
  return {
    provider: o.provider,
    model: o.model,
    route: o.route,
    routeSmallProvider: o.routeSmallProvider,
    routeSmallModel: o.routeSmallModel,
    routeLargeProvider: o.routeLargeProvider,
    routeLargeModel: o.routeLargeModel,
    sessionDb: o.sessionDb,
    persona: o.persona,
    personality: o.personality,
    effort: o.effort,
    instructions: o.instructions,
    configDir: o.configDir,
    projectHome: o.projectDir,
    global: o.global,
    scratch: o.scratch,
    inheritProjectInstructions: o.projectInstructions ?? true,
    inheritProjectMemory: o.projectMemory ?? true,
    verbose: o.verbose,
  };
}
