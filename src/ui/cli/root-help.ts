export const ROOT_COMMAND_HELP = `
Standalone commands:
  migrate-data                    preview or migrate legacy Windows user data
  doctor --windows                check Windows prerequisites and native sandbox enforcement
  terminal [install|uninstall|open] manage Windows Terminal integration and project tabs/panes
  trust                           review and approve project configuration before it can run code
  workflow [command]              initialize, inspect, validate, test, and run strict workflows
  analyze                         analyze recorded sessions and tool usage
  eval                            evaluate agent candidates against scenarios
  improve                         generate and evaluate instruction variants
  acp                             run as an Agent Client Protocol server

Run 'cleetus <command> --help' for command-specific options.`;
