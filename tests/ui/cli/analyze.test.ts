import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../../src/events/log";
import { runAnalyze } from "../../../src/ui/cli/analyze";

function projectWithDb(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "cleetus-analyze-"));
  const log = new EventLog(join(projectDir, ".cleetus", "sessions.db"));
  log.append({ sessionId: "s1", type: "user_input", payload: { text: "hi" } });
  log.append({
    sessionId: "s1",
    type: "tool_call_start",
    payload: { call: { id: "c1", name: "bash", args: {} } },
  });
  log.append({
    sessionId: "s1",
    type: "tool_call_end",
    payload: { call: { id: "c1", name: "bash", args: {} }, ok: true },
  });
  log.append({ sessionId: "s1", type: "assistant_message", payload: { text: "done" } });
  log.close();
  return projectDir;
}

test("prints a human report by default", async () => {
  const dir = projectWithDb();
  let out = "";
  const code = await runAnalyze(["analyze"], dir, {
    write: (s) => {
      out += s;
    },
    writeErr: () => {},
  });
  expect(code).toBe(0);
  expect(out).toContain("Tool reliability");
  expect(out).toContain("bash");
});

test("--json emits a parseable report matching the schema", async () => {
  const dir = projectWithDb();
  let out = "";
  const code = await runAnalyze(["analyze", "--json"], dir, {
    write: (s) => {
      out += s;
    },
    writeErr: () => {},
  });
  expect(code).toBe(0);
  const report = JSON.parse(out);
  expect(report.trajectoryCount).toBe(1);
  expect(report.toolReliability.tools[0].tool).toBe("bash");
});

test("--json with --explain emits JSON only and warns on stderr", async () => {
  const dir = projectWithDb();
  let out = "";
  let err = "";
  await runAnalyze(["analyze", "--json", "--explain"], dir, {
    write: (s) => {
      out += s;
    },
    writeErr: (s) => {
      err += s;
    },
  });
  expect(() => JSON.parse(out)).not.toThrow();
  expect(err).toContain("--explain");
});

test("empty/missing db prints the no-data message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-analyze-empty-"));
  let out = "";
  const code = await runAnalyze(["analyze"], dir, {
    write: (s) => {
      out += s;
    },
    writeErr: () => {},
  });
  expect(code).toBe(0);
  expect(out).toContain("no sessions recorded yet");
});

test("invalid --since returns exit code 2", async () => {
  const dir = projectWithDb();
  let err = "";
  const code = await runAnalyze(["analyze", "--since", "bogus"], dir, {
    write: () => {},
    writeErr: (s) => {
      err += s;
    },
  });
  expect(code).toBe(2);
  expect(err).toContain("since");
});

test("valid --since keeps recent turns and exits 0", async () => {
  const dir = projectWithDb();
  let out = "";
  const code = await runAnalyze(["analyze", "--since", "1d", "--json"], dir, {
    write: (s) => {
      out += s;
    },
    writeErr: () => {},
  });
  expect(code).toBe(0);
  expect(JSON.parse(out).trajectoryCount).toBe(1);
});

test("--session with no matching turns prints a session-specific note", async () => {
  const dir = projectWithDb();
  let out = "";
  const code = await runAnalyze(["analyze", "--session", "nope"], dir, {
    write: (s) => {
      out += s;
    },
    writeErr: () => {},
  });
  expect(code).toBe(0);
  expect(out).toContain("nope");
});
