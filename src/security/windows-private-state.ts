import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

// Use the OS-shipped Windows PowerShell/.NET Framework, not PATH, the selected
// agent shell, icacls output, localized account names, or an execution-policy override.
// FileStream's FileSecurity overload applies the DACL at creation, before any bytes.
export const WINDOWS_PRIVATE_STATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:CLEETUS_PRIVATE_PATH
$action = $env:CLEETUS_PRIVATE_ACTION
$excluded = ConvertFrom-Json $env:CLEETUS_PRIVATE_EXCLUDED
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($user, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
function Security($directory) {
  if ($directory) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $trusted) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    if ($directory) { $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  return $acl
}
function CheckEntry($entry) {
  $entry.Refresh()
  if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private state must not be a reparse point' }
  $owner = $entry.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin $trusted) { throw 'Private state has an untrusted owner' }
}
function Verify($entry) {
  $acl = $entry.GetAccessControl()
  if (-not $acl.AreAccessRulesProtected) { throw 'Private state ACL inheritance remains enabled' }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne $trusted.Count) { throw 'Private state ACL could not be verified' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin $trusted -or $rule.IsInherited -or
        $rule.AccessControlType -ne 'Allow' -or
        ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
      throw 'Private state ACL contains unexpected access'
    }
  }
}
function Protect($entry) {
  CheckEntry $entry
  $directory = $entry -is [System.IO.DirectoryInfo]
  $entry.SetAccessControl((Security $directory))
  Verify $entry
  if ($directory) {
    foreach ($child in $entry.EnumerateFileSystemInfos()) {
      if ($entry.FullName -eq $path -and $child.Name -in $excluded) { CheckEntry $child; continue }
      Protect $child
    }
  }
}
function CreatePrivate($target, $write) {
  if ([System.IO.File]::Exists($target)) {
    Protect (New-Object System.IO.FileInfo($target))
    if (-not $write) { return }
  }
  $stream = New-Object System.IO.FileStream($target, [System.IO.FileMode]::OpenOrCreate,
    [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None,
    4096, [System.IO.FileOptions]::None, (Security $false))
  try {
    Verify (New-Object System.IO.FileInfo($target))
    if ($write) {
      $stream.SetLength(0)
      [Console]::OpenStandardInput().CopyTo($stream)
      $stream.Flush()
    }
  } finally { $stream.Dispose() }
}
try {
  if ($action -eq 'directory') {
    $entry = [System.IO.Directory]::CreateDirectory($path, (Security $true))
    Protect $entry
  } elseif ($action -eq 'file') {
    Protect (New-Object System.IO.FileInfo($path))
  } elseif ($action -eq 'database') {
    foreach ($suffix in @('', '-wal', '-shm')) { CreatePrivate ($path + $suffix) $false }
  } else {
    CreatePrivate $path ($action -eq 'write')
  }
} catch {
  [Console]::Error.WriteLine('Windows private-state ACL operation failed: ' + $_.Exception.Message)
  exit 1
}
`;

export function windowsPrivateState(
  path: string,
  action: "directory" | "file" | "create" | "database" | "write",
  content?: string | Uint8Array,
  excludeChildren: readonly string[] = [],
): void {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new Error("Windows private-state ACL protection requires SystemRoot");
  try {
    execFileSync(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_PRIVATE_STATE_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 64 * 1024,
        input: content === undefined ? undefined : Buffer.from(content),
        env: {
          ...process.env,
          CLEETUS_PRIVATE_PATH: resolve(path),
          CLEETUS_PRIVATE_ACTION: action,
          CLEETUS_PRIVATE_EXCLUDED: JSON.stringify(excludeChildren),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (cause) {
    throw new Error(
      `Could not protect private Windows state at ${path}; no unprotected write was attempted. Ensure this location supports Windows ACLs and the current account can secure it.`,
      { cause },
    );
  }
}
