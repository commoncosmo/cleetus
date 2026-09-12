import { expect, test } from "bun:test";
import {
  BEGIN_SYNC,
  END_SYNC,
  FALLBACK_COLUMNS,
  FALLBACK_ROWS,
  type FrameTarget,
  createFrameWriter,
  syncOutputEnabled,
} from "../../../src/ui/tui/frame-writer";

/** A fake TTY that records each physical write, so tests can assert on write COUNT, not just text. */
function fakeTarget(extra: Record<string, unknown> = {}) {
  const writes: string[] = [];
  const target = {
    writes,
    isTTY: true,
    columns: 100,
    rows: 40,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    ...extra,
  };
  return target as typeof target & FrameTarget;
}

/** Let the queued microtask flush run. */
const settle = () => Promise.resolve();

test("coalesces the writes of one synchronous turn into a single physical write", async () => {
  const target = fakeTarget();
  const { stream } = createFrameWriter(target, { sync: false });

  // Exactly what Ink's static path does: clear, static chunk, then the live frame.
  stream.write("\u001B[2K\u001B[1A");
  stream.write("committed message\n");
  stream.write("live frame");
  expect(target.writes).toEqual([]);

  await settle();
  expect(target.writes).toEqual(["\u001B[2K\u001B[1Acommitted message\nlive frame"]);
});

test("wraps the coalesced frame in synchronized-output markers when enabled", async () => {
  const target = fakeTarget();
  const { stream } = createFrameWriter(target, { sync: true });

  stream.write("a");
  stream.write("b");
  await settle();

  expect(target.writes).toEqual([`${BEGIN_SYNC}ab${END_SYNC}`]);
});

test("emits nothing when no writes were buffered", async () => {
  const target = fakeTarget();
  const { flush } = createFrameWriter(target);
  flush();
  await settle();
  expect(target.writes).toEqual([]);
});

test("separate turns produce separate frames", async () => {
  const target = fakeTarget();
  const { stream } = createFrameWriter(target, { sync: false });

  stream.write("frame one");
  await settle();
  stream.write("frame two");
  await settle();

  expect(target.writes).toEqual(["frame one", "frame two"]);
});

test("onFullClear fires (once, with frame size) when a coalesced frame carries Ink's full-clear", async () => {
  const target = fakeTarget();
  const seen: Array<{ bytes: number }> = [];
  const { stream } = createFrameWriter(target, {
    sync: false,
    onFullClear: (info) => seen.push(info),
  });

  // Ink's outputHeight>=rows branch: clearTerminal (\x1b[2J\x1b[3J\x1b[H) + static + dynamic.
  stream.write("\u001B[2J\u001B[3J\u001B[H");
  stream.write("full static output\n");
  stream.write("dynamic tail");
  await settle();

  expect(seen).toHaveLength(1);
  expect(seen[0]!.bytes).toBe("\u001B[2J\u001B[3J\u001B[Hfull static output\ndynamic tail".length);
});

test("onFullClear stays silent on an ordinary differential frame", async () => {
  const target = fakeTarget();
  const seen: unknown[] = [];
  const { stream } = createFrameWriter(target, {
    sync: false,
    onFullClear: (info) => seen.push(info),
  });

  stream.write("\u001B[2K\u001B[1A");
  stream.write("just a normal diff frame");
  await settle();

  expect(seen).toEqual([]);
});

test("flush emits the buffered frame immediately", () => {
  const target = fakeTarget();
  const { stream, flush } = createFrameWriter(target, { sync: false });

  stream.write("pending");
  flush();
  expect(target.writes).toEqual(["pending"]);
});

test("dispose flushes and then passes writes straight through", async () => {
  const target = fakeTarget();
  const { stream, dispose } = createFrameWriter(target, { sync: false });

  stream.write("buffered");
  dispose();
  expect(target.writes).toEqual(["buffered"]);

  stream.write("after");
  expect(target.writes).toEqual(["buffered", "after"]);
  await settle();
  expect(target.writes).toEqual(["buffered", "after"]);
});

test("proxies live properties through to the real stream", () => {
  const target = fakeTarget();
  const { stream } = createFrameWriter(target);

  expect(stream.columns).toBe(100);
  expect(stream.rows).toBe(40);
  target.columns = 80;
  expect(stream.columns).toBe(80);
});

test("substitutes fallbacks for an unsized pty, so Ink's clear check stays meaningful", () => {
  // rows of 0 makes Ink's `outputHeight >= rows` always true — a full-screen clear every frame.
  const target = fakeTarget({ rows: 0, columns: 0 });
  const { stream } = createFrameWriter(target);

  expect(stream.rows).toBe(FALLBACK_ROWS);
  expect(stream.columns).toBe(FALLBACK_COLUMNS);

  // A real size, once the terminal reports one, wins over the fallback.
  target.rows = 50;
  target.columns = 120;
  expect(stream.rows).toBe(50);
  expect(stream.columns).toBe(120);
});

test("substitutes fallbacks for undefined or nonsense dimensions", () => {
  const { stream } = createFrameWriter(
    fakeTarget({ rows: undefined, columns: Number.NaN }) as FrameTarget & {
      rows?: number;
      columns?: number;
    },
  );
  expect(stream.rows).toBe(FALLBACK_ROWS);
  expect(stream.columns).toBe(FALLBACK_COLUMNS);
});

test("proxies methods bound to the real stream, not the proxy", () => {
  const seen: string[] = [];
  const target = fakeTarget({
    on(event: string) {
      seen.push(event);
      return this;
    },
  });
  const { stream } = createFrameWriter(target);
  (stream as unknown as { on: (e: string) => void }).on("resize");
  expect(seen).toEqual(["resize"]);
});

test("invokes write callbacks only after the frame is actually written", async () => {
  const target = fakeTarget();
  const { stream } = createFrameWriter(target, { sync: false });
  let called = false;

  (stream.write as (c: string, cb: () => void) => boolean)("x", () => {
    called = true;
  });
  expect(called).toBe(false);

  await settle();
  expect(called).toBe(true);
  expect(target.writes).toEqual(["x"]);
});

test("decodes Buffer chunks", async () => {
  const target = fakeTarget();
  const { stream } = createFrameWriter(target, { sync: false });
  (stream.write as unknown as (c: Uint8Array) => boolean)(Buffer.from("héllo", "utf8"));
  await settle();
  expect(target.writes).toEqual(["héllo"]);
});

test("sync is on for a normal TTY", () => {
  expect(syncOutputEnabled({ TERM: "xterm-256color" }, { isTTY: true } as FrameTarget)).toBe(true);
});

test("sync is off when explicitly disabled, non-TTY, or a dumb/absent TERM", () => {
  const tty = { isTTY: true } as FrameTarget;
  expect(syncOutputEnabled({ TERM: "xterm", CLEETUS_NO_SYNC_OUTPUT: "1" }, tty)).toBe(false);
  expect(syncOutputEnabled({ TERM: "xterm" }, { isTTY: false } as FrameTarget)).toBe(false);
  expect(syncOutputEnabled({ TERM: "dumb" }, tty)).toBe(false);
  expect(syncOutputEnabled({}, tty)).toBe(false);
});
