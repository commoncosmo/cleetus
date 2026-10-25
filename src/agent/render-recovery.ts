import type { ToolResult } from "../tools/types";

/** Fixed prerequisites cannot be repaired by changing app code, ports, or background syntax.
 * Scope the stop to one user turn; a fresh turn can retry after environment repair. */
export class RenderRecoveryGuard {
  private blocked = false;
  observe(tool: string, result: ToolResult): void {
    if (tool === "render_check" && result.verificationBlocked) this.blocked = true;
  }
  blocks(tool: string, args: unknown): boolean {
    if (!this.blocked) return false;
    if (tool === "render_check") return true;
    if (tool !== "bash" && tool !== "smoke_run") return false;
    const command = (args as { command?: unknown } | null)?.command;
    return (
      typeof command === "string" &&
      /Start-Process|Start-Job|\$!|\b(?:bun|npm|pnpm|yarn)\s+run\s+(?:dev|preview)\b|(?:curl|Invoke-WebRequest|Get-Content)\b[^\n]*https?:\/\/(?:localhost|127\.0\.0\.1)/i.test(
        command,
      )
    );
  }
  result(): ToolResult {
    return {
      ok: false,
      errorCode: "TOOL_FAILED",
      verificationUnavailable: true,
      verificationBlocked: true,
      errorMessage:
        "Browser verification is unavailable because of a fixed environment prerequisite reported earlier this turn. Stop automatic server/browser workarounds and repeated launches. Continue remaining code/build checks and report browser verification as unverified. Retry in a new turn after the prerequisite is repaired.",
    };
  }
}
