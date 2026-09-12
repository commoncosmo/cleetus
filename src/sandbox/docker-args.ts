import { sentinelMarker } from "./docker-teardown";

/** `docker run` argv (without the leading `docker`) for a session-scoped idle container. */
export function buildRunArgs(image: string, projectDir: string, network: boolean): string[] {
  return [
    "run",
    "-d",
    "--rm",
    "--init", // tini as PID 1 so killed child zombies are reaped immediately
    ...(network ? [] : ["--network", "none"]),
    "-v",
    `${projectDir}:${projectDir}`,
    "-w",
    projectDir,
    image,
    "sleep",
    "infinity",
  ];
}

/** `docker exec` argv (without the leading `docker`) running the command under a `setsid`
 *  process-group leader whose argv carries `#CLEETUS_RUN=<sentinel>` (a shell comment) so a
 *  timed-out run's in-container tree can be found and group-killed. `withStdin` adds `-i` so a
 *  piped stdin payload is forwarded (without it `docker exec` drops the client's stdin). */
export function buildExecArgs(
  containerId: string,
  command: string,
  cwd: string,
  withStdin: boolean,
  sentinel: string,
): string[] {
  return [
    "exec",
    ...(withStdin ? ["-i"] : []),
    "-w",
    cwd,
    containerId,
    "setsid",
    "bash",
    "-c",
    `${command} ${sentinelMarker(sentinel)}`,
  ];
}
