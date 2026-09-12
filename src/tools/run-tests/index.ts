import type { TestConfig } from "../../config/types";
import { detectTestCommand, hasStackMarker } from "./detect";
import type { ResolvedRunner, RunnerResolver } from "./tool";

export { RunTestsTool } from "./tool";
export type { ResolvedRunner, RunnerResolver, RunTestsConfig } from "./tool";

export interface BuiltTestRunner {
  /** Whether to register run_tests at all (stack marker present or a runner detected). */
  register: boolean;
  /** Resolves the runner at call time (re-detects until found). */
  resolve: RunnerResolver;
}

/**
 * Decide whether to register run_tests and how it resolves its runner. Registration keys off
 * a stack marker so a harness scaffolded mid-session becomes usable; the resolver re-runs
 * detection at call time. Detection warnings surface through the tool's actionable error.
 */
export async function buildTestRunner(
  config: TestConfig,
  projectDir: string,
  opts: { registerForAnyProject?: boolean } = {},
): Promise<BuiltTestRunner> {
  const noop: RunnerResolver = async () => ({ runner: null, warnings: [] });
  if (!config.enabled) return { register: false, resolve: noop };

  const register = opts.registerForAnyProject || (await hasStackMarker(projectDir, config));
  const resolve: RunnerResolver = async (activeProjectDir = projectDir, check = "test") => {
    const { command, warnings } = await detectTestCommand(
      activeProjectDir,
      config,
      undefined,
      check,
    );
    const runner: ResolvedRunner | null = command
      ? { runnerId: command.runnerId, argv: command.argv, summaryRegex: command.summaryRegex }
      : null;
    return { runner, warnings };
  };
  return { register, resolve };
}
