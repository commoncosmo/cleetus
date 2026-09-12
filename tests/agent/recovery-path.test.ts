import { expect, test } from "bun:test";
import {
  projectAuditDbPath,
  projectCheckpointMirrorDir,
  projectRecoveryDir,
} from "../../src/agent/recovery-path";

test("project recovery paths are stable, distinct, and outside the project", () => {
  const root = "/Users/example/.config/cleetus";
  const project = "/Users/example/WebstormProjects/sysprompter";
  const recovery = projectRecoveryDir(root, project);
  expect(recovery).toStartWith(`${root}/recovery/sysprompter-`);
  expect(recovery).not.toStartWith(project);
  expect(projectAuditDbPath(root, project)).toBe(`${recovery}/events.db`);
  expect(projectCheckpointMirrorDir(root, project)).toBe(`${recovery}/checkpoints.git`);
  expect(projectRecoveryDir(root, project)).toBe(recovery);
  expect(projectRecoveryDir(root, "/tmp/sysprompter")).not.toBe(recovery);
});
