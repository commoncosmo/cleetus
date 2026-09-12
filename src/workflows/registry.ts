import { type WorkflowDiagnostic, discoverWorkflows } from "./discover";
import type { WorkflowPackage } from "./package";

export class WorkflowRegistry {
  private packages = new Map<string, WorkflowPackage>();
  private diagnosticList: WorkflowDiagnostic[] = [];

  constructor(
    private readonly locations: {
      projectDir: string;
      globalDir: string;
    },
  ) {
    this.refresh();
  }

  refresh(): void {
    const discovered = discoverWorkflows(this.locations);
    this.packages.clear();
    this.diagnosticList = [...discovered.diagnostics];
    for (const pkg of discovered.workflows) {
      const existing = this.packages.get(pkg.name);
      if (!existing) {
        this.packages.set(pkg.name, pkg);
        continue;
      }
      if (existing.source === "project") {
        this.diagnosticList.push({
          level: "warning",
          source: pkg.source,
          path: pkg.dir,
          message: `workflow '${pkg.name}' is shadowed by project package ${existing.dir}`,
        });
        continue;
      }
      this.diagnosticList.push({
        level: "warning",
        source: existing.source,
        path: existing.dir,
        message: `workflow '${pkg.name}' is shadowed by project package ${pkg.dir}`,
      });
      this.packages.set(pkg.name, pkg);
    }
  }

  list(): WorkflowPackage[] {
    return [...this.packages.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): WorkflowPackage | undefined {
    return this.packages.get(name);
  }

  resolveName(input: string): string | undefined {
    const normalized = input.trim().toLowerCase();
    if (this.packages.has(normalized)) return normalized;
    const matches = this.list().filter((pkg) => pkg.name.startsWith(normalized));
    return matches.length === 1 ? matches[0]!.name : undefined;
  }

  diagnostics(): WorkflowDiagnostic[] {
    return [...this.diagnosticList];
  }
}
