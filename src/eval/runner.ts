import { ulid } from "ulid";
import type { RouteMode } from "../agent/route-modes";
import { type Tiers, createRouter } from "../agent/router";
import { AgentRuntime } from "../agent/runtime";
import type { ModelChoice } from "../agent/selector";
import type { SandboxConfig, SmartConfig } from "../config/types";
import { EventLog } from "../events/log";
import { writeEscapesProject } from "../permission/path-guard";
import type { ProviderRegistry } from "../providers/registry";
import { type Sandbox, SandboxUnavailableError } from "../sandbox/types";
import { BashTool } from "../tools/bash";
import { ToolDispatcher } from "../tools/dispatcher";
import { EditFileTool } from "../tools/edit-file";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";
import { ReadFileTool } from "../tools/read-file";
import { ToolRegistry } from "../tools/registry";
import type { Tool } from "../tools/types";
import { WriteFileTool } from "../tools/write-file";
import type { Candidate } from "./candidate";
import type { Scenario } from "./scenario";
import type { RunRecord } from "./types";
import { cleanupWorkspace, prepareWorkspace } from "./workspace";

export interface RunnerDeps {
  providers: ProviderRegistry;
  sandboxConfig: SandboxConfig;
  makeSandbox: (cfg: SandboxConfig, dir: string) => Sandbox;
  baseline: {
    systemPrompt: string;
    active: ModelChoice;
    mode: RouteMode;
    tiers?: Tiers;
    smart: SmartConfig;
    maxToolLoops: number;
  };
}

/** The eval coding tool set. `remember`/`code_search` are deliberately excluded (isolation). */
function buildEvalTools(sandbox: Sandbox, allow?: string[]): ToolRegistry {
  const all: Tool[] = [
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new BashTool(sandbox),
    new GlobTool(),
    new GrepTool(),
  ];
  const reg = new ToolRegistry();
  for (const t of all) {
    if (!allow || allow.includes(t.name)) reg.register(t);
  }
  return reg;
}

/** Run one candidate against one scenario in a fresh sandbox; capture + return the raw record. */
export async function runCandidate(
  candidate: Candidate,
  scenario: Scenario,
  deps: RunnerDeps,
): Promise<RunRecord> {
  const start = Date.now();
  const tempDir = await prepareWorkspace(scenario);
  const log = new EventLog(":memory:");
  const sessionId = ulid();
  let sandbox: Sandbox | undefined;
  let agentOutcome: RunRecord["agentOutcome"] = "completed";
  let checkExitCode: number | null = null;

  try {
    sandbox = deps.makeSandbox(deps.sandboxConfig, tempDir);
    const tools = buildEvalTools(sandbox, candidate.tools);
    const dispatcher = new ToolDispatcher(tools);
    const router = createRouter({
      getMode: () => candidate.routing?.mode ?? deps.baseline.mode,
      getActive: () => deps.baseline.active,
      tiers: candidate.routing?.tiers ?? deps.baseline.tiers,
      smart: deps.baseline.smart,
    });
    const runtime = new AgentRuntime({
      providers: deps.providers,
      tools,
      dispatcher,
      log,
      router,
      systemPrompt: () => candidate.systemPrompt ?? deps.baseline.systemPrompt,
      projectDir: tempDir,
      // Unattended, but still deny writes/edits that escape the isolated workdir.
      resolvePermission: async ({ tool, args }) =>
        (await writeEscapesProject(tool, args, tempDir)) ? "deny" : "allow",
      maxToolLoops: deps.baseline.maxToolLoops,
    });

    const ac = new AbortController();
    // Safe against a race: setTimeout fires as a macrotask, so it cannot interleave
    // between `await runTurn(...)` resolving and the next synchronous line reading timedOut.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, scenario.agentTimeoutMs);
    try {
      await runtime.runTurn(sessionId, scenario.prompt, ac.signal);
      agentOutcome = timedOut ? "timed_out" : "completed";
    } catch {
      agentOutcome = timedOut ? "timed_out" : "error";
    } finally {
      clearTimeout(timer);
    }

    try {
      const res = await sandbox.exec(scenario.check, {
        cwd: tempDir,
        timeoutMs: scenario.checkTimeoutMs,
        signal: new AbortController().signal,
      });
      checkExitCode = res.exitCode;
    } catch (e) {
      if (e instanceof SandboxUnavailableError) {
        // Only relabel a clean run; keep a prior timed_out/error as the root cause.
        if (agentOutcome === "completed") agentOutcome = "sandbox_unavailable";
        checkExitCode = null;
      } else {
        throw e;
      }
    }
  } finally {
    await sandbox?.dispose().catch(() => {});
    await cleanupWorkspace(tempDir).catch(() => {});
  }

  const events = log.query(sessionId);
  log.close();
  return {
    candidate: candidate.name,
    scenario: scenario.name,
    events,
    checkExitCode,
    agentOutcome,
    elapsedMs: Date.now() - start,
  };
}
