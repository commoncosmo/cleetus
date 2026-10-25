import type { Sandbox } from "../sandbox/types";
import { canonicalProjectCwd } from "./project-services";

/** Separate local execution boundaries per canonical session project. */
export class AcpSandboxRegistry {
  private readonly entries = new Map<string, Promise<Sandbox>>();
  constructor(private readonly create: (cwd: string) => Promise<Sandbox>) {}
  async seed(cwd: string, sandbox: Sandbox): Promise<void> {
    this.entries.set(await canonicalProjectCwd(cwd), Promise.resolve(sandbox));
  }
  async get(cwd: string): Promise<Sandbox> {
    const key = await canonicalProjectCwd(cwd);
    let pending = this.entries.get(key);
    if (!pending) {
      pending = this.create(key);
      this.entries.set(key, pending);
      pending.catch(() => {
        if (this.entries.get(key) === pending) this.entries.delete(key);
      });
    }
    return pending;
  }
  async dispose(): Promise<void> {
    const entries = await Promise.allSettled(this.entries.values());
    this.entries.clear();
    await Promise.all(
      entries
        .filter((entry): entry is PromiseFulfilledResult<Sandbox> => entry.status === "fulfilled")
        .map((entry) => entry.value.dispose()),
    );
  }
}
