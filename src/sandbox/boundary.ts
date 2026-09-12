/** True when command output carries an OS write-denial signature, across sandbox backends:
 *  EPERM (Seatbelt), EACCES, or EROFS (bwrap / read-only Docker mounts). We match the shell's
 *  error text rather than parsing the command — the OS sandbox is the enforcement layer. */
export function looksLikeWriteDenial(output: string): boolean {
  return /operation not permitted|permission denied|read-only file system/i.test(output);
}

/** Startup notice when the active sandbox does not confine writes (writeRoot === null), else
 *  null. The DEGRADED variant (host sandbox requested but unavailable) must name the concrete
 *  lost protections; the plain variant covers an explicit, informed `backend: "none"`. */
export function unconfinedSandboxNotice(writeRoot: string | null, degraded = false): string | null {
  if (writeRoot !== null) return null;
  if (!degraded) {
    return "sandbox backend does not confine writes; bash can write anywhere on the host.";
  }
  return (
    "SANDBOX DEGRADED: no host sandbox is available on this platform, so bash runs unconfined. " +
    ".git and .cleetus (including the checkpoint store) are NOT write-protected and secret dirs " +
    "(~/.ssh, ~/.aws, ~/.gnupg, …) are NOT read-protected for shell commands. Persisted bash " +
    "allow rules are suspended — every command will prompt. Install bubblewrap, switch to the " +
    'docker backend, or set sandbox.backend: "none" to opt in explicitly.'
  );
}
