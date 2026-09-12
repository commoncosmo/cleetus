import { TOP_ERRORS } from "../constants";
import type { Trajectory } from "../trajectory";

export interface ToolStat {
  tool: string;
  calls: number;
  failures: number;
  failureRate: number;
  topErrors: { message: string; count: number }[];
}
export interface ToolReliability {
  tools: ToolStat[];
}

export function analyzeToolReliability(trajectories: Trajectory[]): ToolReliability {
  const calls = new Map<string, number>();
  const failures = new Map<string, number>();
  const errors = new Map<string, Map<string, number>>();

  for (const t of trajectories) {
    for (const c of t.toolCalls) {
      calls.set(c.name, (calls.get(c.name) ?? 0) + 1);
      if (!c.ok) {
        failures.set(c.name, (failures.get(c.name) ?? 0) + 1);
        if (c.errorMessage) {
          let perTool = errors.get(c.name);
          if (!perTool) {
            perTool = new Map();
            errors.set(c.name, perTool);
          }
          perTool.set(c.errorMessage, (perTool.get(c.errorMessage) ?? 0) + 1);
        }
      }
    }
  }

  const tools: ToolStat[] = [...calls.entries()].map(([tool, callCount]) => {
    const fail = failures.get(tool) ?? 0;
    const topErrors = [...(errors.get(tool)?.entries() ?? [])]
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
      .slice(0, TOP_ERRORS);
    return {
      tool,
      calls: callCount,
      failures: fail,
      failureRate: callCount > 0 ? fail / callCount : 0,
      topErrors,
    };
  });

  tools.sort(
    (a, b) => b.failures - a.failures || b.calls - a.calls || a.tool.localeCompare(b.tool),
  );
  return { tools };
}
