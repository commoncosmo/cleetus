import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../src/events/log";
import type { EventInput } from "../../src/events/types";

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-events-"));
  log = new EventLog(join(dir, "sessions.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

const evt = (overrides: Partial<EventInput> = {}): EventInput => ({
  sessionId: "s1",
  type: "user_input",
  payload: { text: "hello" },
  ...overrides,
});

describe("EventLog", () => {
  it("append never throws when the DB write fails; listeners still fire", () => {
    const local = new EventLog(join(dir, "local.db"));
    let notified = 0;
    local.subscribe("s1", () => {
      notified++;
    });
    local.close(); // force the next INSERT to fail (handle closed)
    let returned: ReturnType<typeof local.append> | undefined;
    // A failed persist must not abort the caller (the model turn) — it's a side-channel log.
    expect(() => {
      returned = local.append(evt());
    }).not.toThrow();
    expect(returned?.id).toBeTruthy();
    expect(notified).toBe(1); // the live view still got the event
  });

  it("reports a persistent write failure once, not once per event (no console flood)", () => {
    const local = new EventLog(join(dir, "flood.db"));
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      local.close(); // force every subsequent INSERT to fail (handle closed), like a deleted .cleetus dir
      for (let i = 0; i < 6; i++) local.append(evt({ payload: { text: `r${i}` } }));
    } finally {
      console.error = orig;
    }
    // Six failed appends → exactly one "write failed" line, not six.
    expect(errors.filter((l) => l.includes("event log write failed")).length).toBe(1);
    // ...plus a single clear one-time explanation.
    expect(errors.filter((l) => l.includes("persistence lost")).length).toBe(1);
  });

  it("append stores and assigns id and ts", () => {
    const e = log.append(evt());
    expect(e.id).toBeTruthy();
    expect(e.ts).toBeGreaterThan(0);
    expect(e.type).toBe("user_input");
  });

  it("mirrors events to an external recovery database", () => {
    const mirrorPath = join(dir, "recovery", "events.db");
    const mirrored = new EventLog(join(dir, "project", ".cleetus", "sessions.db"), {
      mirrorPath,
    });
    mirrored.append(evt({ payload: { text: "survives project deletion" } }));
    mirrored.close();

    const recovery = new EventLog(mirrorPath);
    expect(recovery.query("s1").map((event) => event.payload)).toEqual([
      { text: "survives project deletion" },
    ]);
    recovery.close();
  });

  it("keeps running when the advisory recovery mirror cannot be initialized", async () => {
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "file");
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    let local: EventLog | undefined;
    try {
      expect(() => {
        local = new EventLog(join(dir, "primary.db"), {
          mirrorPath: join(blocker, "events.db"),
        });
      }).not.toThrow();
      local!.append(evt());
      expect(local!.query("s1")).toHaveLength(1);
    } finally {
      local?.close();
      console.error = orig;
    }
    expect(errors.filter((line) => line.includes("recovery event log unavailable"))).toHaveLength(
      1,
    );
  });

  it("query returns events for a session in order", () => {
    log.append(evt({ sessionId: "s1", payload: { text: "1" } }));
    log.append(evt({ sessionId: "s2", payload: { text: "X" } }));
    log.append(evt({ sessionId: "s1", payload: { text: "2" } }));
    const result = log.query("s1");
    expect(result.length).toBe(2);
    expect((result[0]!.payload as { text: string }).text).toBe("1");
    expect((result[1]!.payload as { text: string }).text).toBe("2");
  });

  it("subscribe receives appended events for the session only", async () => {
    const received: string[] = [];
    const unsub = log.subscribe("s1", (e) => {
      received.push((e.payload as { text: string }).text);
    });
    log.append(evt({ sessionId: "s1", payload: { text: "A" } }));
    log.append(evt({ sessionId: "s2", payload: { text: "B" } }));
    log.append(evt({ sessionId: "s1", payload: { text: "C" } }));
    expect(received).toEqual(["A", "C"]);
    unsub();
    log.append(evt({ sessionId: "s1", payload: { text: "D" } }));
    expect(received).toEqual(["A", "C"]);
  });

  it("listSessions returns distinct session ids in first-seen order", () => {
    log.append({ sessionId: "s1", type: "user_input", payload: { text: "a" } });
    log.append({ sessionId: "s2", type: "user_input", payload: { text: "b" } });
    log.append({ sessionId: "s1", type: "assistant_message", payload: { text: "c" } });
    log.append({ sessionId: "s3", type: "user_input", payload: { text: "d" } });
    expect(log.listSessions()).toEqual(["s1", "s2", "s3"]);
  });
});
