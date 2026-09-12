/**
 * Connection-wide FIFO for operations that temporarily install active-session adapters into the
 * shared AgentRuntime. ACP permits independent sessions to prompt concurrently, but Cleetus's
 * permission, filesystem, sandbox, configuration, and project-service adapters are selected for
 * one active turn. Serializing those turns preserves correctness without blocking the transport:
 * cancel notifications still run immediately and can abort either the active or a queued turn.
 */
export class AcpTurnQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
