/** Correct known command mistakes without suggesting environment repair. */
export function powershellHint(command: string, output: string): string | null {
  if (/parameter name 'la'/i.test(output))
    return "PowerShell uses Get-ChildItem -Force; ls -la is Bash syntax.";
  if (/term 'which'/i.test(output))
    return "Discover executables with Get-Command <name> | Select-Object -ExpandProperty Source.";
  if (/parameter name 'UseBasicParsing'/i.test(output) && /Get-Content/i.test(command))
    return "Fetch HTTP with Invoke-WebRequest -Uri <url>; Get-Content reads filesystem paths.";
  if (/positional parameter/i.test(output) && /Remove-Item/i.test(command))
    return "Pass multiple paths as a PowerShell array: Remove-Item -LiteralPath 'one.log','two.log' -Force.";
  if (/positional parameter/i.test(output) && /Get-ChildItem/i.test(command))
    return "Use Get-ChildItem -LiteralPath 'src','public' -Recurse; PowerShell parameters use one dash, e.g. -Include.";
  if (
    /could not find a part|cannot find path/i.test(output) &&
    /(?:\/tmp\/|[A-Z]:\\tmp\\)/i.test(command)
  )
    return "Use Join-Path $env:CLEETUS_TEMP 'filename' for scratch files; /tmp is not a native Windows temp directory.";
  if (/Start-Process|Start-Job|\$!/.test(command))
    return "Use render_check with launchCommand for browser verification; it owns the server and browser lifetime. Run existing npm scripts directly instead of backgrounding npm/npx shims. Environment variables, jobs, and servers do not persist between tool calls.";
  return null;
}
