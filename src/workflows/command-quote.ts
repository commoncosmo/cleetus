/** POSIX-quote one argv value so the existing shell-backed Sandbox receives inert data. */
export function quoteWorkflowArg(value: string): string {
  if (value === "") return "''";
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function quoteWorkflowCommand(program: string, args: string[]): string {
  return [program, ...args].map(quoteWorkflowArg).join(" ");
}
