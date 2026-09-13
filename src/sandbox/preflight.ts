import type { Sandbox } from "./types";

/** A short health check prevents an unusable host jail from failing only after a tool approval. */
export const HOST_SANDBOX_PREFLIGHT_TIMEOUT_MS = 2_000;

/**
 * Run a harmless command through the fully constructed host sandbox. Returning a message rather
 * than throwing makes the factory's degraded fallback explicit and easy to test.
 */
export async function preflightHostSandbox(sandbox: Pick<Sandbox, "exec">): Promise<string | null> {
  const controller = new AbortController();
  try {
    const result = await sandbox.exec("true", {
      timeoutMs: HOST_SANDBOX_PREFLIGHT_TIMEOUT_MS,
      signal: controller.signal,
    });
    if (result.timedOut)
      return `health check timed out after ${HOST_SANDBOX_PREFLIGHT_TIMEOUT_MS}ms`;
    if (result.cancelled) return "health check was cancelled";
    if (result.exitCode === 0) return null;
    const detail = [result.stderr, result.stdout].find((text) => text.trim().length > 0)?.trim();
    return detail
      ? `health check exited ${result.exitCode}: ${detail}`
      : `health check exited ${result.exitCode}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
