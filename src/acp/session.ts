import { ulid } from "ulid";

/** Tracks the live ACP sessions. An ACP sessionId is a cleetus ulid session id directly. */
export class AcpSessions {
  private readonly cwds = new Map<string, string>();

  create(cwd: string): string {
    const id = ulid();
    this.cwds.set(id, cwd);
    return id;
  }

  /** Register a session under a client-supplied id (used by `session/load`, where the id is
   *  chosen by the client rather than minted here). Idempotent. */
  adopt(id: string, cwd: string): void {
    this.cwds.set(id, cwd);
  }

  has(id: string): boolean {
    return this.cwds.has(id);
  }

  cwd(id: string): string | undefined {
    return this.cwds.get(id);
  }
}
