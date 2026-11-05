import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { startupTiming } from "../lib/startup-timings";

// Use the OS-shipped Windows PowerShell/.NET Framework, not PATH, the selected
// agent shell, icacls output, localized account names, or an execution-policy override.
// FileStream's FileSecurity overload applies the DACL at creation, before any bytes.
export const WINDOWS_PRIVATE_STATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$requests = ConvertFrom-Json ([Console]::In.ReadToEnd())
$visited = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$script:inspected = 0
$script:repaired = 0
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
  $directory = $entry -is [System.IO.DirectoryInfo]
  if (-not $visited.Contains($entry.FullName)) {
    CheckEntry $entry
    $script:inspected++
    try { Verify $entry } catch {
      $entry.SetAccessControl((Security $directory))
      Verify $entry
      $script:repaired++
    }
    $null = $visited.Add($entry.FullName)
  }
  if ($directory) {
    foreach ($child in $entry.EnumerateFileSystemInfos()) {
      if ($entry.FullName -eq $path -and $child.Name -in $excluded) { CheckEntry $child; continue }
      Protect $child
    }
  }
}
function CreatePrivate($target, $write, $content) {
  if ([System.IO.File]::Exists($target)) {
    Protect (New-Object System.IO.FileInfo($target))
    if (-not $write) { return }
  }
  $stream = New-Object System.IO.FileStream($target, [System.IO.FileMode]::OpenOrCreate,
    [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None,
    4096, [System.IO.FileOptions]::None, (Security $false))
  try {
    if (-not $visited.Contains($target)) {
      $script:inspected++
      $null = $visited.Add($target)
    }
    Verify (New-Object System.IO.FileInfo($target))
    if ($write) {
      $stream.SetLength(0)
      $bytes = [Convert]::FromBase64String($content)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
    }
  } finally { $stream.Dispose() }
}
try {
 foreach ($request in $requests) {
  $path = $request.path
  $action = $request.action
  $excluded = @($request.excludeChildren)
  if ($action -eq 'directory') {
    $entry = [System.IO.Directory]::CreateDirectory($path, (Security $true))
    Protect $entry
  } elseif ($action -eq 'file') {
    Protect (New-Object System.IO.FileInfo($path))
  } elseif ($action -eq 'database') {
    foreach ($suffix in @('', '-wal', '-shm')) { CreatePrivate ($path + $suffix) $false '' }
  } else {
    CreatePrivate $path ($action -eq 'write') $request.content
  }
 }
 [Console]::Out.Write((ConvertTo-Json -Compress @{ inspected=$script:inspected; repaired=$script:repaired }))
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
  windowsPrivateStates([
    {
      path,
      action,
      content: content === undefined ? undefined : Buffer.from(content).toString("base64"),
      excludeChildren,
    },
  ]);
}

export interface WindowsPrivateOperation {
  path: string;
  action: "directory" | "file" | "create" | "database" | "write";
  content?: string;
  excludeChildren?: readonly string[];
}

export function windowsPrivateStates(operations: readonly WindowsPrivateOperation[]): {
  inspected: number;
  repaired: number;
} {
  if (!operations.length) return { inspected: 0, repaired: 0 };
  const start = performance.now();
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new Error("Windows private-state ACL protection requires SystemRoot");
  try {
    const output = execFileSync(
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
        input: JSON.stringify(operations.map((op) => ({ ...op, path: resolve(op.path) }))),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const counts = JSON.parse(output.toString("utf8")) as { inspected: number; repaired: number };
    startupTiming(
      "Windows ACL batch",
      start,
      `${operations.length} operations, ${counts.inspected} inspected, ${counts.repaired} repaired`,
    );
    return counts;
  } catch (cause) {
    throw new Error(
      `Could not protect private Windows state at ${operations[0]!.path}; no unprotected write was attempted. Ensure this location supports Windows ACLs and the current account can secure it.`,
      { cause },
    );
  }
}
