const DURATION = /^([1-9]\d*)(ms|s|m)$/;
const MULTIPLIER: Record<"ms" | "s" | "m", number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
};

/** Parse the deliberately small workflow duration syntax into a safe integer millisecond value. */
export function parseWorkflowDuration(value: unknown, path = "duration"): number {
  if (typeof value !== "string") throw new Error(`${path} must be a duration string`);
  const match = DURATION.exec(value);
  if (!match) throw new Error(`${path} must be a positive integer followed by ms, s, or m`);
  const amount = Number(match[1]);
  const milliseconds = amount * MULTIPLIER[match[2] as keyof typeof MULTIPLIER];
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`${path} is outside the supported range`);
  }
  return milliseconds;
}
