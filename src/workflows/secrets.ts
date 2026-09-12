import type { WorkflowManifest } from "./parse";
import { type ResolvedValue, resolved } from "./provenance";

export interface WorkflowSecretAvailability {
  available: string[];
  missing: string[];
}

type SecretDeclarations = NonNullable<WorkflowManifest["secrets"]>;

export class WorkflowSecretResolver {
  constructor(
    private readonly declarations: SecretDeclarations,
    private readonly environment: Record<string, string | undefined> = process.env,
  ) {}

  availability(
    names: Iterable<string> = Object.keys(this.declarations),
  ): WorkflowSecretAvailability {
    const available: string[] = [];
    const missing: string[] = [];
    for (const name of [...names].sort()) {
      const declaration = this.declarations[name];
      if (!declaration) throw new Error(`workflow secret '${name}' is not declared`);
      if (this.environment[declaration.name] === undefined) missing.push(name);
      else available.push(name);
    }
    return { available, missing };
  }

  resolve(name: string): ResolvedValue<string> {
    const declaration = this.declarations[name];
    if (!declaration) throw new Error(`workflow secret '${name}' is not declared`);
    const value = this.environment[declaration.name];
    if (value === undefined) throw new Error(`required workflow secret '${name}' is unavailable`);
    return resolved(value, {
      sensitive: true,
      origins: [`secret:${name}`],
    });
  }

  assertLlmExposure(name: string, stepId: string): void {
    const declaration = this.declarations[name];
    if (!declaration) throw new Error(`workflow secret '${name}' is not declared`);
    if (!declaration.expose_to_llm?.includes(stepId)) {
      throw new Error(`workflow secret '${name}' is not approved for LLM step '${stepId}'`);
    }
  }
}
