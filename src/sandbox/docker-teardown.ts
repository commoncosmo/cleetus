/**
 * In-container teardown helpers for the Docker sandbox. The workload is launched as a
 * `setsid` process-group leader whose argv carries a unique comment marker; teardown finds
 * that leader by the marker (`pgrep -f`) and signals the whole group (`kill -SIG -<pgid>`).
 */

/** Unique no-op shell comment placed in the leader shell's argv. Only the leader carries it
 *  (forked children re-exec and replace their argv), so it is a precise handle to the group
 *  leader — whose pid equals its pgid under `setsid`. */
export const sentinelMarker = (sentinel: string): string => `#CLEETUS_RUN=${sentinel}`;

/** Parse `pgrep` stdout (one PID per line) into positive integers, ignoring blanks/noise. */
export function parsePids(stdout: string): number[] {
  return stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}
