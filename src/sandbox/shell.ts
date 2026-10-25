/** EncodedCommand avoids the extra Windows command-line quoting layer for scripts. */
export function powershellArgs(command: string): string[] {
  // Native nonzero exits must not abort buffered downstream filters. Keep cmdlet
  // failures terminating, drain native output, then return the first native failure.
  const script = `$ErrorActionPreference='Continue'; $PSDefaultParameterValues['*:ErrorAction']='Stop'; $Error.Clear(); $ProgressPreference='SilentlyContinue'; $PSNativeCommandUseErrorActionPreference=$true; $PSStyle.OutputRendering='PlainText'; if ($env:CLEETUS_TEMP) { $env:TEMP=$env:CLEETUS_TEMP; $env:TMP=$env:CLEETUS_TEMP; $env:TMPDIR=$env:CLEETUS_TEMP }; $global:LASTEXITCODE=0; $script:cleetusCommandFailed=$false; try { & {\n${command}\nif (!$?) { $script:cleetusCommandFailed=$true }\n} | Out-String -Stream -Width 240; $nativeFailure=@($Error | Where-Object { $_.Exception -is [System.Management.Automation.NativeCommandExitException] }); if ($nativeFailure.Count) { exit $nativeFailure[-1].Exception.ExitCode }; if ($script:cleetusCommandFailed) { exit 1 }; exit $global:LASTEXITCODE } catch { [Console]::Error.WriteLine($_.ToString()); if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE }; exit 1 }`;
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-OutputFormat",
    "Text",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}
