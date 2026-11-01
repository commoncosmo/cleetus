# Standalone regression harness: no Pester, network, installed Cleetus, or user PATH writes.
$ErrorActionPreference = 'Stop'
$env:CLEETUS_INSTALLER_TEST = '1'
. (Join-Path $PSScriptRoot '../../install.ps1')

function Assert-CleetusTest($Condition, [string]$Message) { if (-not $Condition) { throw "Assertion failed: $Message" } }
function Assert-CleetusFailure([scriptblock]$Action, [string]$Pattern) {
    $caught = $false
    try { & $Action } catch { $caught = $true; Assert-CleetusTest ($_.Exception.Message -match $Pattern) $_.Exception.Message }
    Assert-CleetusTest $caught "Expected failure matching $Pattern"
}

Assert-CleetusTest ((Get-CleetusArchitecture -MachineArchitecture ARM64 -WowArchitecture '' -ProcessArchitecture AMD64) -eq 'arm64') 'ARM OS from emulated x64 shell'
Assert-CleetusTest ((Get-CleetusArchitecture -MachineArchitecture '' -WowArchitecture ARM64 -ProcessArchitecture x86) -eq 'arm64') 'WOW architecture fallback'
Assert-CleetusTest ((Get-CleetusArchitecture -MachineArchitecture AMD64 -WowArchitecture '' -ProcessArchitecture x86) -eq 'x64') 'x64 OS from 32-bit shell'
Assert-CleetusFailure { Get-CleetusArchitecture -MachineArchitecture x86 -WowArchitecture '' -ProcessArchitecture x86 } 'Unsupported'
Assert-CleetusFailure { Get-CleetusRelease '../bad' } 'Invalid'
Assert-CleetusTest ((Get-CleetusUpdatedPath 'C:\Apps\Cleetus\bin' 'D:\Other;C:\APPS\Cleetus\bin\;%USERPROFILE%\tools') -eq 'C:\Apps\Cleetus\bin;D:\Other;%USERPROFILE%\tools') 'PATH deduplicates case-insensitively and preserves other entries'

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('.cleetus-installer-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$savedPath = $env:Path
$savedPortable = $env:CLEETUS_PORTABLE
$savedTerminalProfile = $env:CLEETUS_TERMINAL_PROFILE
$env:CLEETUS_TERMINAL_PROFILE = '0'
$env:CLEETUS_PORTABLE = '0'
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
    $fixture = Join-Path $testRoot 'fixture'
    [IO.Directory]::CreateDirectory((Join-Path $fixture 'native/_manifest')) | Out-Null
    foreach ($name in @('cleetus.exe', 'native/wxc-exec.exe', 'native/MXC-LICENSE.md', 'native/_manifest/notice.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'ACKNOWLEDGEMENTS.md')) { [IO.File]::WriteAllText((Join-Path $fixture $name), 'fixture') }
    $script:FixtureArchive = Join-Path $testRoot 'fixture.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($fixture, $script:FixtureArchive)
    $script:BadChecksum = $false
    $script:FixtureArch = 'arm64'
    $script:DownloadUrls = New-Object 'System.Collections.Generic.List[string]'
    $script:ResolutionCount = 0
    $script:VerificationCount = 0
    $script:TerminalRegistrations = New-Object 'System.Collections.Generic.List[string]'
    function Register-CleetusTerminalProfile { param([string]$Executable); $script:TerminalRegistrations.Add($Executable) }
    function Get-CleetusRelease { param([string]$RequestedVersion); $script:ResolutionCount++; return 'v9.9.9' }
    function Get-CleetusArchitecture { return $script:FixtureArch }
    function Save-CleetusDownload {
        param([string]$Url, [string]$Destination)
        $script:DownloadUrls.Add($Url)
        if ($Url.EndsWith('checksums.txt')) {
            $sha = [Security.Cryptography.SHA256]::Create(); $inputStream = [IO.File]::OpenRead($script:FixtureArchive)
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($inputStream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose(); $inputStream.Dispose() }
            if ($script:BadChecksum) { $hash = '0' * 64 }
            [IO.File]::WriteAllText($Destination, "$hash  cleetus-windows-$script:FixtureArch.zip`n")
        } else { [IO.File]::Copy($script:FixtureArchive, $Destination) }
    }
    function Invoke-CleetusInstalledCheck { param([string]$Executable, [string]$Tag, [switch]$SkipDoctor); $script:VerificationCount++ }
    function Test-CleetusPortableSupport { return $true }
    function Assert-CleetusCandidateVersion { param([string]$Executable, [string]$Tag) }
    $app = Join-Path $testRoot ("spaces and apostrophe's " + [char]0x03A9)
    Install-Cleetus -InstallDir $app -NoPath -SkipDoctor
    Assert-CleetusTest (Test-Path -LiteralPath (Join-Path $app 'bin/native/wxc-exec.exe')) 'MXC runtime installed'
    Assert-CleetusTest ($script:ResolutionCount -eq 1) 'latest resolved once'
    Assert-CleetusTest ($script:DownloadUrls.Count -eq 2) 'two release files downloaded'
    Assert-CleetusTest ($script:DownloadUrls[0] -match '/v9.9.9/cleetus-windows-arm64.zip$') 'resolved release and architecture used'
    Assert-CleetusTest ($env:Path -eq $savedPath) 'NoPath never changes the current PATH'
    Assert-CleetusTest ($script:TerminalRegistrations.Count -eq 0) 'Terminal profile is opt in'
    Install-Cleetus -InstallDir $app -NoPath -SkipDoctor -TerminalProfile
    Assert-CleetusTest ($script:TerminalRegistrations.Count -eq 1) 'Terminal profile requested once'
    Assert-CleetusTest ($script:TerminalRegistrations[0] -eq (Join-Path $app 'bin/cleetus.exe')) 'absolute installed executable registers profile'
    $env:CLEETUS_TERMINAL_PROFILE = '1'
    Install-Cleetus -InstallDir $app -NoPath -SkipDoctor
    $env:CLEETUS_TERMINAL_PROFILE = '0'
    Assert-CleetusTest ($script:TerminalRegistrations.Count -eq 2) 'environment flag opts into Terminal profile'
    function Register-CleetusTerminalProfile { param([string]$Executable); throw 'fixture optional registration failure' }
    Install-Cleetus -InstallDir $app -NoPath -SkipDoctor -TerminalProfile
    Assert-CleetusTest (Test-Path -LiteralPath (Join-Path $app 'bin/cleetus.exe')) 'optional profile failure does not roll back binary installation'
    $portableApp = Join-Path $testRoot 'portable'
    Install-Cleetus -InstallDir $portableApp -Portable -NoPath -SkipDoctor
    Assert-CleetusTest (Test-Path -LiteralPath (Join-Path $portableApp 'cleetus.portable')) 'portable marker'
    [IO.Directory]::CreateDirectory((Join-Path $portableApp 'data')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $portableApp 'data/config.yaml'), 'preserve me')
    $script:FixtureArch = 'x64'
    Install-Cleetus -InstallDir $portableApp -NoPath -SkipDoctor
    Assert-CleetusTest ([IO.File]::ReadAllText((Join-Path $portableApp 'data/config.yaml')) -eq 'preserve me') 'upgrade preserves portable data'
    Assert-CleetusTest (Test-Path -LiteralPath (Join-Path $portableApp 'cleetus.portable')) 'upgrade preserves portable mode'
    function Assert-CleetusCandidateVersion { throw 'fixture version mismatch' }
    Assert-CleetusFailure { Install-Cleetus -InstallDir $portableApp -NoPath -SkipDoctor } 'version mismatch'
    Assert-CleetusTest ([IO.File]::ReadAllText((Join-Path $portableApp 'bin/cleetus.exe')) -eq 'fixture') 'version mismatch preserves the old executable'
    function Assert-CleetusCandidateVersion { param([string]$Executable, [string]$Tag) }
    function Test-CleetusPortableSupport { return $false }
    Assert-CleetusFailure { Install-Cleetus -InstallDir $portableApp -NoPath -SkipDoctor } 'cannot confirm portable'
    Assert-CleetusTest ([IO.File]::ReadAllText((Join-Path $portableApp 'data/config.yaml')) -eq 'preserve me') 'old release cannot escape portable storage'
    function Test-CleetusPortableSupport { return $true }
    $script:BadChecksum = $true
    Assert-CleetusFailure { Install-Cleetus -InstallDir $portableApp -NoPath -SkipDoctor } 'Checksum mismatch'
    Assert-CleetusTest ([IO.File]::ReadAllText((Join-Path $portableApp 'bin/cleetus.exe')) -eq 'fixture') 'checksum failure preserves old binary'
    $script:BadChecksum = $false
    $script:FailPublish = $true
    function Move-CleetusDirectory {
        param([string]$Source, [string]$Destination)
        if ($script:FailPublish -and [IO.Path]::GetFileName($Source) -eq 'payload') { $script:FailPublish = $false; throw 'fixture replacement failure' }
        [IO.Directory]::Move($Source, $Destination)
    }
    [IO.File]::WriteAllText((Join-Path $portableApp 'bin/cleetus.exe'), 'old binary')
    Assert-CleetusFailure { Install-Cleetus -InstallDir $portableApp -NoPath -SkipDoctor } 'fixture replacement failure'
    Assert-CleetusTest ([IO.File]::ReadAllText((Join-Path $portableApp 'bin/cleetus.exe')) -eq 'old binary') 'failed replacement rolls back old bin'
    $held = [IO.File]::Open((Join-Path $portableApp 'bin/cleetus.exe'), 'Open', 'ReadWrite', 'None')
    try { Assert-CleetusFailure { Install-Cleetus -InstallDir $portableApp -NoPath -SkipDoctor } 'Close Cleetus' } finally { $held.Dispose() }
    Assert-CleetusTest ([IO.File]::ReadAllText((Join-Path $portableApp 'data/config.yaml')) -eq 'preserve me') 'locked-file failure preserves data'
    Assert-CleetusTest (@(Get-ChildItem -LiteralPath $portableApp -Force | Where-Object { $_.Name -like '.cleetus-stage-*' -or $_.Name -like '.cleetus-backup-*' }).Count -eq 0) 'owned temporary directories cleaned'
    $unsafe = Join-Path $testRoot 'unsafe.zip'
    $zip = [IO.Compression.ZipFile]::Open($unsafe, [IO.Compression.ZipArchiveMode]::Create)
    try { $zip.CreateEntry('../escape.txt') | Out-Null } finally { $zip.Dispose() }
    Assert-CleetusFailure { Expand-CleetusPackage $unsafe (Join-Path $testRoot 'unsafe-out') } 'Unsafe ZIP'
    Assert-CleetusTest (-not (Test-Path -LiteralPath (Join-Path $testRoot 'escape.txt'))) 'ZIP traversal never extracted'
    $incomplete = Join-Path $testRoot 'incomplete.zip'
    $zip = [IO.Compression.ZipFile]::Open($incomplete, [IO.Compression.ZipArchiveMode]::Create)
    try { $zip.CreateEntry('cleetus.exe') | Out-Null } finally { $zip.Dispose() }
    Assert-CleetusFailure { Expand-CleetusPackage $incomplete (Join-Path $testRoot 'incomplete-out') } 'Incomplete package'
    Write-Host "WINDOWS_INSTALLER_PASS PowerShell $($PSVersionTable.PSVersion)"
} finally {
    $env:Path = $savedPath
    $env:CLEETUS_PORTABLE = $savedPortable
    $env:CLEETUS_TERMINAL_PROFILE = $savedTerminalProfile
    $absolute = [IO.Path]::GetFullPath($testRoot)
    if ($absolute.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($absolute).StartsWith('.cleetus-installer-test-')) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}
