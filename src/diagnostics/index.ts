import type { DiagnosticsConfig } from "../config/types";
import { DiagnosticsManager, type ManagerProvider } from "./manager";
import { GoProvider } from "./providers/go";
import { PythonProvider } from "./providers/python";
import { RustProvider } from "./providers/rust";
import { TypeScriptProvider } from "./providers/typescript";
import type { DiagnosticExec, DiagnosticsProvider } from "./types";

export interface BuiltDiagnostics {
  manager: DiagnosticsManager | undefined;
  warnings: string[];
}

function allProviders(): DiagnosticsProvider[] {
  return [new TypeScriptProvider(), new PythonProvider(), new GoProvider(), new RustProvider()];
}

/**
 * Detect which checkers apply to this project and are installed, and build a manager.
 * Returns no manager when disabled or when no provider is active. A provider whose
 * marker is present but whose checker is missing yields a one-time warning.
 */
export async function buildDiagnosticsManager(
  config: DiagnosticsConfig,
  projectDir: string,
  exec?: DiagnosticExec,
): Promise<BuiltDiagnostics> {
  if (!config.enabled) return { manager: undefined, warnings: [] };

  const candidates = allProviders().filter(
    (p) => !config.languages || config.languages.includes(p.language),
  );

  const active: ManagerProvider[] = [];
  const warnings: string[] = [];
  for (const provider of candidates) {
    if (!(await provider.hasProjectMarker(projectDir))) continue;
    const cmd = await provider.detect(projectDir);
    if (cmd) active.push({ provider, cmd });
    else
      warnings.push(
        `${provider.language} diagnostics unavailable: '${provider.id}' checker not found`,
      );
  }

  if (active.length === 0) return { manager: undefined, warnings };

  const manager = new DiagnosticsManager({
    projectDir,
    providers: active,
    timeoutMs: config.timeoutMs,
    maxReported: config.maxReported,
    exec,
  });
  return { manager, warnings };
}
