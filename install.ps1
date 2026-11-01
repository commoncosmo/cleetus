# Windows bootstrap installer. Supports Windows PowerShell 5.1 and PowerShell 7.
# irm https://raw.githubusercontent.com/commoncosmo/cleetus/main/install.ps1 | iex
[CmdletBinding()]
param(
    [string]$Version = $env:CLEETUS_VERSION,
    [string]$InstallDir = $env:CLEETUS_INSTALL_DIR,
    [switch]$Portable,
    [switch]$NoPath,
    [switch]$SkipDoctor,
    [switch]$TerminalProfile
)

function Get-CleetusArchitecture {
    param(
        [string]$MachineArchitecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE', 'Machine'),
        [string]$WowArchitecture = $env:PROCESSOR_ARCHITEW6432,
        [string]$ProcessArchitecture = $env:PROCESSOR_ARCHITECTURE
    )
    # Machine/WOW architecture takes priority over an emulated shell's process architecture.
    foreach ($candidate in @($MachineArchitecture, $WowArchitecture, $ProcessArchitecture)) {
        switch ($candidate.ToUpperInvariant()) {
            'ARM64' { return 'arm64' }
            'AMD64' { return 'x64' }
            'X64' { return 'x64' }
        }
    }
    throw 'Unsupported Windows architecture. Cleetus requires x64 or ARM64 Windows.'
}

function Get-CleetusRelease {
    param([string]$RequestedVersion)
    if ($RequestedVersion) {
        if ($RequestedVersion -notmatch '^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$') { throw 'Invalid CLEETUS_VERSION/version.' }
        return 'v' + $RequestedVersion.TrimStart('v')
    }
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/commoncosmo/cleetus/releases/latest' -Headers @{ 'User-Agent' = 'Cleetus-Installer' } -ErrorAction Stop
    if ($release.tag_name -notmatch '^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$') { throw 'Release API returned an invalid tag.' }
    return $release.tag_name
}

function Save-CleetusDownload {
    param([string]$Url, [string]$Destination)
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -Headers @{ 'User-Agent' = 'Cleetus-Installer' } -ErrorAction Stop
}

function Test-CleetusChecksum {
    param([string]$Archive, [string]$Asset, [string]$Checksums)
    $expected = @()
    $pattern = '^([a-fA-F0-9]{64})\s+\*?' + [Regex]::Escape($Asset) + '$'
    foreach ($line in [IO.File]::ReadAllLines($Checksums)) { if ($line -cmatch $pattern) { $expected += $Matches[1].ToLowerInvariant() } }
    if ($expected.Count -ne 1) { throw "Expected exactly one checksum for $Asset." }
    $stream = [IO.File]::OpenRead($Archive)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    if ($actual -ne $expected[0]) { throw "Checksum mismatch for $Asset. Existing installation was not changed." }
}

function Expand-CleetusPackage {
    param([string]$Archive, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name -ieq 'cleetus.portable' -or $name -imatch '^data(?:/|$)') { throw 'Release payload must not contain portable markers or user data; the installer manages those outside bin.' }
            if ($name.StartsWith('/') -or $name.Contains(':') -or $name.Split('/') -contains '..' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw "Unsafe ZIP entry: $name" }
            if (-not $names.Add($name)) { throw "Duplicate ZIP entry: $name" }
        }
        foreach ($required in @('cleetus.exe', 'native/wxc-exec.exe', 'native/MXC-LICENSE.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'ACKNOWLEDGEMENTS.md')) {
            if (-not $names.Contains($required)) { throw "Incomplete package: missing $required" }
        }
        if (-not @($names | Where-Object { $_.StartsWith('native/_manifest/') }).Count) { throw 'Incomplete package: missing native software inventory.' }
    } finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
}

function Remove-CleetusTemporaryTree {
    param([string]$Path, [string]$OwnerRoot)
    $absolute = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetFullPath($OwnerRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($absolute).StartsWith('.cleetus-'))) { throw 'Refusing cleanup outside the installer-owned temporary directory.' }
    if (Test-Path -LiteralPath $absolute) {
        # Refuse junctions rather than following them during recursive cleanup.
        $pending = New-Object 'System.Collections.Generic.Stack[string]'
        $pending.Push($absolute)
        while ($pending.Count) {
            $current = Get-Item -LiteralPath $pending.Pop() -Force
            if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cleanup deferred for linked path: $($current.FullName)" }
            if ($current.PSIsContainer) { foreach ($child in Get-ChildItem -LiteralPath $current.FullName -Force) { $pending.Push($child.FullName) } }
        }
        Remove-Item -LiteralPath $absolute -Recurse -Force -ErrorAction Stop
    }
}

function Get-CleetusUpdatedPath {
    param([string]$Bin, [string]$ExistingPath)
    $same = { param($entry) [Environment]::ExpandEnvironmentVariables($entry.Trim('"').TrimEnd('\', '/')).Equals($Bin.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase) }
    $entries = @($ExistingPath -split ';' | Where-Object { $_ -and -not (& $same $_) })
    return (@($Bin) + $entries -join ';')
}

function Add-CleetusPath {
    param([string]$Bin)
    [Environment]::SetEnvironmentVariable('Path', (Get-CleetusUpdatedPath $Bin ([Environment]::GetEnvironmentVariable('Path', 'User'))), 'User')
    $env:Path = Get-CleetusUpdatedPath $Bin $env:Path
}

function Invoke-CleetusInstalledCheck {
    param([string]$Executable, [string]$Tag, [switch]$SkipDoctor)
    $reported = & $Executable --version
    if ($LASTEXITCODE -ne 0 -or $reported.Trim() -ne $Tag.TrimStart('v')) { throw 'Installed executable version check failed.' }
    if (-not $SkipDoctor) { & $Executable doctor --windows --quick; if ($LASTEXITCODE -ne 0) { Write-Warning 'Installation completed; doctor found missing prerequisites. Use unpackaged PowerShell 7.4+ MSI/ZIP and rerun cleetus doctor.' } }
}

function Register-CleetusTerminalProfile {
    param([string]$Executable)
    & $Executable terminal install
    if ($LASTEXITCODE -ne 0) { throw 'Terminal profile registration failed. Retry with cleetus terminal install after installing a release that supports it.' }
}

function Assert-CleetusCandidateVersion {
    param([string]$Executable, [string]$Tag)
    try {
        $reported = & $Executable --version
        if ($LASTEXITCODE -ne 0 -or $reported.Trim() -ne $Tag.TrimStart('v')) { throw 'Package executable does not match the selected version.' }
    } catch { throw "Cannot verify downloaded executable; existing installation was not changed. Check application-control policy and the selected release. $($_.Exception.Message)" }
}

function Move-CleetusDirectory {
    param([string]$Source, [string]$Destination)
    [IO.Directory]::Move($Source, $Destination)
}

function Test-CleetusPortableSupport {
    param([string]$Executable)
    $previousPortable = $env:CLEETUS_PORTABLE
    try {
        $env:CLEETUS_PORTABLE = '1'
        $output = & $Executable --print-user-paths 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }
        $paths = $output | ConvertFrom-Json
        return $paths.layoutVersion -ge 1 -and $paths.mode -eq 'portable'
    } catch { return $false }
    finally { $env:CLEETUS_PORTABLE = $previousPortable }
}

function Install-Cleetus {
    [CmdletBinding()]
    param([string]$Version, [string]$InstallDir, [switch]$Portable, [switch]$NoPath, [switch]$SkipDoctor, [switch]$TerminalProfile)
    $ErrorActionPreference = 'Stop'
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This installer is for Windows.' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Cleetus' }
    $root = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\', '/')
    if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\', '/') -or $root -eq $env:USERPROFILE -or $root -eq $env:LOCALAPPDATA) { throw 'Choose an application-specific installation directory.' }
    [IO.Directory]::CreateDirectory($root) | Out-Null
    if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation directory must not be a junction or symbolic link.' }
    $bin = Join-Path $root 'bin'
    $record = Join-Path $bin '.cleetus-install.json'
    if ((Test-Path -LiteralPath $bin) -and -not (Test-Path -LiteralPath $record -PathType Leaf)) { throw 'Existing bin directory is not owned by this installer. Choose another directory.' }
    $id = [Guid]::NewGuid().ToString('N')
    $temporary = Join-Path $root ('.cleetus-stage-' + $id)
    $backup = Join-Path $root ('.cleetus-backup-' + $id)
    $lock = $null
    $committed = $false
    $oldMoved = $false
    $createdPortableMarker = $false
    try {
        $lock = [IO.File]::Open((Join-Path $root '.cleetus-install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        [IO.Directory]::CreateDirectory($temporary) | Out-Null
        $tag = Get-CleetusRelease $Version
        $arch = Get-CleetusArchitecture
        $asset = "cleetus-windows-$arch.zip"
        $base = "https://github.com/commoncosmo/cleetus/releases/download/$tag"
        $archive = Join-Path $temporary $asset
        $checksums = Join-Path $temporary 'checksums.txt'
        Write-Host "Cleetus installer: downloading $tag ($arch)..."
        Save-CleetusDownload "$base/$asset" $archive
        Save-CleetusDownload "$base/checksums.txt" $checksums
        Test-CleetusChecksum $archive $asset $checksums
        $payload = Join-Path $temporary 'payload'
        Expand-CleetusPackage $archive $payload
        Assert-CleetusCandidateVersion (Join-Path $payload 'cleetus.exe') $tag
        $supportsDataPaths = Test-CleetusPortableSupport (Join-Path $payload 'cleetus.exe')
        if (($Portable -or $env:CLEETUS_PORTABLE -eq '1' -or (Test-Path -LiteralPath (Join-Path $root 'cleetus.portable'))) -and -not $supportsDataPaths) { throw 'Selected executable cannot confirm portable data support. Choose a release containing native data paths and ensure application-control policy permits it. Existing installation was not changed.' }
        [IO.File]::WriteAllText((Join-Path $payload '.cleetus-install.json'), (@{ schema = 1; version = $tag; architecture = $arch } | ConvertTo-Json))
        $portableMarker = Join-Path $root 'cleetus.portable'
        if (($Portable -or $env:CLEETUS_PORTABLE -eq '1') -and -not (Test-Path -LiteralPath $portableMarker)) {
            [IO.File]::WriteAllText($portableMarker, ''); $createdPortableMarker = $true
        }
        if (Test-Path -LiteralPath $bin) {
            if ((Get-Item -LiteralPath $bin -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Existing bin directory must not be a junction.' }
            foreach ($name in @('cleetus.exe', 'native\wxc-exec.exe')) {
                $existing = Join-Path $bin $name
                if (Test-Path -LiteralPath $existing) { try { $handle = [IO.File]::Open($existing, 'Open', 'ReadWrite', 'None'); $handle.Dispose() } catch { throw "Close Cleetus and its child processes before upgrading: $existing" } }
            }
            Move-CleetusDirectory $bin $backup; $oldMoved = $true
        }
        try { Move-CleetusDirectory $payload $bin }
        catch {
            if ($oldMoved) {
                try { Move-CleetusDirectory $backup $bin; $oldMoved = $false }
                catch { throw "Installation replacement failed. Restore $backup to $bin manually; user data was not changed. $($_.Exception.Message)" }
            }
            throw
        }
        # Data lives outside bin and is never part of an upgrade/rollback swap.
        $committed = $true
        if ($Portable) { $env:CLEETUS_PORTABLE = '1' }
        if (-not $NoPath) { try { Add-CleetusPath $bin } catch { Write-Warning "Installed files, but PATH could not be updated: $($_.Exception.Message)"; $NoPath = $true } }
        Write-Host "Cleetus installer: installed $bin\cleetus.exe"
        if ($Portable -or (Test-Path -LiteralPath (Join-Path $root 'cleetus.portable'))) { Write-Host "Portable data: $root\data (preserved on upgrades)." }
        elseif ($supportsDataPaths) { Write-Host "User data: $env:LOCALAPPDATA\Cleetus. Existing legacy data remains active until 'cleetus migrate-data --yes' succeeds." }
        else { Write-Host 'This release uses the legacy data layout. Native paths and migration require a newer release; data was not migrated by this installer.' }
        try {
            Invoke-CleetusInstalledCheck (Join-Path $bin 'cleetus.exe') $tag -SkipDoctor:$SkipDoctor
        } catch { Write-Warning "Files installed, but execution verification failed. Check application-control policy and prerequisites. $($_.Exception.Message)" }
        if ($TerminalProfile -or $env:CLEETUS_TERMINAL_PROFILE -eq '1') {
            try { Register-CleetusTerminalProfile (Join-Path $bin 'cleetus.exe') }
            catch { Write-Warning "Cleetus is installed, but its optional Terminal profile was not registered. $($_.Exception.Message)" }
        }
        if ($NoPath) { Write-Host "PATH was unchanged. Run: $bin\cleetus.exe" }
        else {
            $resolved = Get-Command cleetus -ErrorAction SilentlyContinue
            if ($resolved -and $resolved.Source -ne (Join-Path $bin 'cleetus.exe')) { Write-Warning "Another command shadows this installation: $($resolved.Source)" }
            Write-Host 'Restart other terminals/editors to inherit the new PATH.'
        }
    } finally {
        if ($lock) { $lock.Dispose() }
        if (-not $committed -and $createdPortableMarker) { [IO.File]::Delete($portableMarker) }
        foreach ($owned in @($temporary) + @(if ($committed) { $backup })) {
            try { Remove-CleetusTemporaryTree $owned $root } catch { Write-Warning $_.Exception.Message }
        }
    }
}

if ($env:CLEETUS_INSTALLER_TEST -ne '1') {
    try { Install-Cleetus -Version $Version -InstallDir $InstallDir -Portable:$Portable -NoPath:$NoPath -SkipDoctor:$SkipDoctor -TerminalProfile:$TerminalProfile }
    catch { throw "Cleetus installation failed: $($_.Exception.Message)" }
}
