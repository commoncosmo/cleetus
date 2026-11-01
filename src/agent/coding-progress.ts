import { relative } from "node:path";
import type { ToolCall } from "../providers/types";
import type { ToolResult } from "../tools/types";
import { normalizeCacheKey } from "../web/fetch-cache";

/** Advisory only: recognizing inspection must never grant permission or authorize replay. */
export function isResearchInspection(call: Pick<ToolCall, "name" | "args">): boolean {
  if (["read_file", "grep", "glob", "web_fetch", "web_search", "code_search"].includes(call.name))
    return true;
  if (call.name !== "bash") return false;
  const command = (call.args as { command?: unknown })?.command;
  return (
    typeof command === "string" &&
    /^(?:Get-Content|Get-ChildItem|Select-String|Test-Path|rg|grep|ls|head|tail|cat)\b/i.test(
      command.trim(),
    ) &&
    !/\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Start-Process|Invoke-Expression|npm|npx|bun|node)\b/i.test(
      command,
    )
  );
}

/** Track concrete execution evidence across mixed shell/document research, not intentions. */
export class CodingProgressGuard {
  private inspections = 0;
  private documentMisses = 0;
  private readonly ranges = new Map<string, [number, number][]>();
  private readonly paths = new Set<string>();
  private generated = false;
  private latestCheck = "No verification has executed this turn.";

  constructor(
    private readonly projectDir: string,
    private readonly scaffoldOnly: boolean,
  ) {}

  observe(
    call: Pick<ToolCall, "name" | "args">,
    result: ToolResult,
    verificationKey?: string | null,
  ): { madeProgress: boolean; reminder?: string } {
    let madeProgress = result.ok;
    if (result.ok && result.diff?.path) {
      this.paths.add(relative(this.projectDir, result.diff.path));
      this.inspections = 0;
      this.documentMisses = 0;
      this.latestCheck =
        "Previous verification predates the latest confirmed write; reverify after integration.";
    }
    if (result.ok && call.name === "scaffold") {
      this.generated = true;
      this.inspections = 0;
    }
    const doc = result.documentation;
    if (call.name === "web_fetch" && doc) {
      const key = normalizeCacheKey(doc.url);
      const ranges = doc.cached ? (this.ranges.get(key) ?? []) : [];
      if (!doc.matched || doc.startLine === undefined || doc.endLine === undefined) {
        madeProgress = false;
      } else {
        let unseen = false;
        for (let line = doc.startLine; line <= doc.endLine; line++) {
          if (!ranges.some(([start, end]) => line >= start && line <= end)) {
            unseen = true;
            break;
          }
        }
        madeProgress = unseen;
        // Merge overlaps to keep coverage bounded independently of query/formatting variants.
        const merged: [number, number][] = [];
        for (const range of [...ranges, [doc.startLine, doc.endLine] as [number, number]].sort(
          (a, b) => a[0] - b[0],
        )) {
          const last = merged.at(-1);
          if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
          else merged.push([...range]);
        }
        this.ranges.delete(key);
        this.ranges.set(key, merged.slice(-64));
        if (this.ranges.size > 16) this.ranges.delete(this.ranges.keys().next().value!);
      }
      if (!madeProgress) this.documentMisses++;
    }
    if (
      verificationKey ||
      ["run_tests", "render_check", "smoke_run"].includes(call.name) ||
      result.verification
    ) {
      this.latestCheck = `${verificationKey ?? call.name}: ${result.ok ? "passed" : "failed or unverified"}; ${(result.output ?? result.errorMessage ?? "no outcome recorded").replace(/[\r\n]+/g, " ").slice(0, 350)}`;
    }
    const inspection = isResearchInspection(call);
    if (inspection) this.inspections++;
    const stalled = inspection && this.inspections > 0 && this.inspections % 10 === 0;
    const repeatedDocument =
      !madeProgress &&
      this.documentMisses > 0 &&
      this.documentMisses % 3 === 0 &&
      call.name === "web_fetch";
    if (!stalled && !repeatedDocument) return { madeProgress };
    return {
      madeProgress,
      reminder: `IMPLEMENTATION CHECKPOINT: ${this.inspections} inspection calls since the last confirmed edit; ${this.documentMisses} empty or already-covered documentation reads. ${this.snapshot()} Stop repeating broad research. Use the established setup example to make the smallest coherent integration patch. If a specific compiler diagnostic remains, run one focused probe to resolve it, then edit or report the concrete blocker. Intended edits and passing template builds are not evidence that the requested framework is connected.`,
    };
  }

  snapshot(): string {
    return `${this.generated ? "Base scaffold generation succeeded. " : ""}Confirmed writes this turn: ${
      [...this.paths]
        .slice(-8)
        .map((path) => path.slice(0, 90))
        .join(", ") || "none"
    }. ${this.latestCheck}${this.scaffoldOnly ? " Scaffold-only scope: connect the requested framework and entry point before optional behavior or test dependencies. Verify the actual changed UI." : ""}`;
  }
}
