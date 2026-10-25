/** Only emit trusted application state, and only to an interactive Windows Terminal. */
export function terminalProgress(
  state: "running" | "waiting" | "clear",
  output: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!output.isTTY || !env.WT_SESSION || env.CLEETUS_TERMINAL_PROGRESS === "0") return;
  const code = state === "running" ? 3 : state === "waiting" ? 4 : 0;
  output.write(`\x1b]9;4;${code};0\x07`);
}
