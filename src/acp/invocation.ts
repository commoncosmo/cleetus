/** True when cleetus was launched as `cleetus acp` — the headless Agent Client Protocol agent.
 *
 *  Both `bun <script> acp` and the compiled binary (`cleetus acp`) present `process.argv` as
 *  `[exec, exec-or-script, ...userArgs]`, so the first user token is `argv[2]` — the same
 *  convention the `analyze`/`eval`/`improve` subcommands use. This MUST be an early `argv`
 *  branch, not a commander `.command("acp")`: registering any subcommand turns the root into a
 *  command container, which breaks the default `[prompt...]` invocation (a bare `cleetus`
 *  prints help instead of opening the TUI, and `cleetus "<prompt>"` errors as an unknown
 *  command). Kept dependency-free so the top-of-`main` import never eagerly loads the ACP
 *  runtime — that stays behind a lazy `import("./server")`. */
export function isAcpInvocation(argv: string[]): boolean {
  return argv[2] === "acp";
}
