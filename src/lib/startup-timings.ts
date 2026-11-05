let enabled = process.env.CLEETUS_STARTUP_TIMINGS === "1";

/** Timings go to stderr so ACP stdout remains a protocol stream. No paths,
 * configuration values, credentials, or model requests are recorded. */
export function enableStartupTimings(value: boolean): void {
  enabled = value || process.env.CLEETUS_STARTUP_TIMINGS === "1";
}

export function startupTiming(label: string, start: number, detail = ""): void {
  if (enabled)
    process.stderr.write(
      `[cleetus startup] ${label}: ${(performance.now() - start).toFixed(1)} ms${detail ? ` (${detail})` : ""}\n`,
    );
}

export function startupSync<T>(label: string, run: () => T): T {
  const start = performance.now();
  try {
    return run();
  } finally {
    startupTiming(label, start);
  }
}

export async function startupAsync<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    startupTiming(label, start);
  }
}

export function startupReady(): void {
  startupTiming("ready (process total)", performance.now() - process.uptime() * 1000);
}
