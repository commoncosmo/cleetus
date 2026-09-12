import type { EventSource } from "../events/log";
import {
  type PermissionPatterns,
  analyzePermissionPatterns,
} from "./analyzers/permission-patterns";
import { type ReasoningCost, analyzeReasoningCost } from "./analyzers/reasoning-cost";
import { type RoutingCost, analyzeRoutingCost } from "./analyzers/routing-cost";
import { type ToolReliability, analyzeToolReliability } from "./analyzers/tool-reliability";
import { type TurnEfficiency, analyzeTurnEfficiency } from "./analyzers/turn-efficiency";
import { type Trajectory, segmentTrajectories } from "./trajectory";

export interface InsightsFilter {
  since?: number; // ms epoch; keep trajectories with startTs >= since
  sessionId?: string;
}

export interface InsightsReport {
  filter: InsightsFilter;
  sessionCount: number;
  trajectoryCount: number;
  toolReliability: ToolReliability;
  turnEfficiency: TurnEfficiency;
  permissionPatterns: PermissionPatterns;
  routingCost: RoutingCost;
  reasoningCost: ReasoningCost;
}

export function collectTrajectories(source: EventSource, filter: InsightsFilter): Trajectory[] {
  const sessionIds = filter.sessionId ? [filter.sessionId] : source.listSessions();
  const out: Trajectory[] = [];
  for (const id of sessionIds) {
    for (const t of segmentTrajectories(source.query(id))) {
      if (filter.since != null && t.startTs < filter.since) continue;
      out.push(t);
    }
  }
  return out;
}

export function analyze(source: EventSource, filter: InsightsFilter): InsightsReport {
  const trajectories = collectTrajectories(source, filter);
  const sessionCount = new Set(trajectories.map((t) => t.sessionId)).size;
  return {
    filter,
    sessionCount,
    trajectoryCount: trajectories.length,
    toolReliability: analyzeToolReliability(trajectories),
    turnEfficiency: analyzeTurnEfficiency(trajectories),
    permissionPatterns: analyzePermissionPatterns(trajectories),
    routingCost: analyzeRoutingCost(trajectories),
    reasoningCost: analyzeReasoningCost(trajectories),
  };
}
