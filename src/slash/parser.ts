export interface ParsedSlash {
  name: string;
  args: string;
}

export function parseSlashCommand(input: string): ParsedSlash | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const sp = body.indexOf(" ");
  if (sp === -1) return { name: body, args: "" };
  return { name: body.slice(0, sp), args: body.slice(sp + 1).trim() };
}
