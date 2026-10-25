import { shellJoin } from "../git/quote";
import type { ExecOptions, Sandbox } from "./types";

/** Preserve argv rather than interpolating generated arguments into a shell. */
export function execProgram(sandbox: Sandbox, argv: string[], opts: ExecOptions) {
  if (sandbox.execArgv) return sandbox.execArgv(argv, opts);
  const command =
    sandbox.shell === "powershell"
      ? `& ${argv.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}`
      : shellJoin(argv);
  return sandbox.exec(command, opts);
}
