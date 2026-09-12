/**
 * Standalone probe: does the frame-writer Proxy survive REAL Ink?
 *
 * Not a `.test.tsx` on purpose. Ink disables its whole frame path when `is-in-ci` detects CI — no
 * resize subscription, static output only, never a frame — which would make every assertion here
 * vacuous on GitHub Actions. `is-in-ci` reads the environment once at import time, and Bun shares
 * the module registry across test files (many of which pull in Ink transitively), so scrubbing the
 * environment from inside the suite is too late.
 *
 * So this runs as its own process with the CI markers stripped, spawned by
 * frame-writer-ink.test.ts. Exits 0 on success, 1 with a diagnostic on failure.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Box, Static, Text, render } from "ink";
import type { Event } from "../../../src/events/types";
import { BEGIN_SYNC, END_SYNC, createFrameWriter } from "../../../src/ui/tui/frame-writer";
import { History } from "../../../src/ui/tui/history";
import { seedHistory, settlePending } from "../../../src/ui/tui/history-model";
import {
  LIVE_WINDOW_RESERVE,
  liveWindowBudget,
  liveWindowReserve,
} from "../../../src/ui/tui/stream-window";

/** A fake TTY: a real EventEmitter (so Ink's `resize` subscription works) that records writes. */
function fakeTty() {
  const stream = new EventEmitter() as EventEmitter & {
    writes: string[];
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): boolean;
  };
  stream.writes = [];
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  stream.write = (chunk: string) => {
    stream.writes.push(chunk);
    return true;
  };
  return stream;
}

function Transcript({ count }: { count: number }) {
  const committed = Array.from({ length: count }, (_, i) => `committed ${i}`);
  return (
    <Box flexDirection="column">
      <Static items={committed}>{(item) => <Text key={item}>{item}</Text>}</Static>
      <Text>live region {count}</Text>
    </Box>
  );
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const asStdout = (s: unknown) => s as unknown as NodeJS.WriteStream;

/** Every frame Ink emits is one atomic, self-contained synchronized write. */
async function framesAreAtomic() {
  const tty = fakeTty();
  const writer = createFrameWriter(tty, { sync: true });

  // patchConsole off: it would swallow this process's own output.
  const app = render(<Transcript count={1} />, {
    stdout: asStdout(writer.stream),
    patchConsole: false,
  });

  // Each rerender commits another message to <Static> — Ink's three-write path.
  for (let n = 2; n <= 6; n++) {
    app.rerender(<Transcript count={n} />);
    await settle(40);
  }
  await settle(50);
  // `waitUntilExit()` is deliberately not awaited: Ink only wires its exit promise on first call,
  // so awaiting it after unmount never resolves.
  app.unmount();
  writer.dispose();

  assert.ok(tty.writes.length > 0, "expected Ink to write at least one frame");
  // Ink emits ~33 physical writes for this sequence; coalescing brings it to one per frame.
  assert.ok(
    tty.writes.length <= 8,
    `expected <=8 coalesced writes, got ${tty.writes.length} — coalescing regressed`,
  );
  for (const write of tty.writes) {
    assert.ok(write.startsWith(BEGIN_SYNC), "frame did not open with the synchronized-output mark");
    assert.ok(write.endsWith(END_SYNC), "frame did not close with the synchronized-output mark");
  }
  const all = tty.writes.join("");
  assert.ok(all.includes("committed 0"), "missing first static row");
  assert.ok(all.includes("committed 5"), "missing last static row");
  // The live (non-static) region proves Ink took its frame path, not the CI-only static path.
  assert.ok(all.includes("live region"), "Ink took its CI path — the probe asserted nothing");
}

/** Ink reads live dimensions off the Proxy and subscribes to resize on the real emitter. */
async function dimensionsAndResize() {
  const tty = fakeTty();
  const writer = createFrameWriter(tty, { sync: false });
  const app = render(<Text>x</Text>, { stdout: asStdout(writer.stream), patchConsole: false });

  assert.ok(
    tty.listenerCount("resize") > 0,
    "Ink did not subscribe to resize on the underlying emitter",
  );
  tty.columns = 40;
  assert.equal(writer.stream.columns, 40, "Proxy did not report the live column count");

  app.unmount();
  writer.dispose();
  assert.equal(tty.listenerCount("resize"), 0, "Proxy leaked a resize listener");
}

/** An unsized pty (rows 0) must not trip Ink's full-screen-clear branch. */
async function unsizedPtyDoesNotClear() {
  const tty = fakeTty();
  tty.rows = 0;
  tty.columns = 0;
  const writer = createFrameWriter(tty, { sync: false });

  const app = render(<Transcript count={2} />, {
    stdout: asStdout(writer.stream),
    patchConsole: false,
  });
  await settle(50);
  app.unmount();
  writer.dispose();

  // ansiEscapes.clearTerminal on POSIX is ESC[2J ESC[3J ESC[H.
  const all = tty.writes.join("");
  assert.ok(!all.includes("[2J"), "rows of 0 put Ink into its full-screen-clear branch");
  assert.ok(all.includes("live region"), "Ink took its CI path — the probe asserted nothing");
}

/**
 * The "duplicate final answer" regression. A finished assistant answer taller than the viewport,
 * left in the dynamic region (`model.pending`), drives `outputHeight >= rows` and makes Ink take
 * its `clearTerminal` branch — which reprints the whole transcript and duplicates the answer into
 * scrollback.
 *
 * The fix commits a finished answer straight to `<Static>` as it arrives (advanceHistory /
 * seedHistory), so it never sits in the dynamic region and Ink never clears. This proves all of it:
 * the reducer commits the answer (no clear); the mechanism it guards against is real (force the
 * answer back into the dynamic region and a tall one clears); and `settlePending` still recovers a
 * regressed state (the idle safety net for a turn that ends on a trailing row).
 */
async function finishedAnswerCommitsAndDoesNotClear() {
  const bigText = Array.from({ length: 20 }, (_, i) => `answer line ${i}`).join("\n");
  const events = [
    { id: "u1", sessionId: "s", ts: 1, type: "user_input", payload: { text: "hi" } },
    { id: "m1", sessionId: "s", ts: 2, type: "model_call_start", payload: { callId: "c1" } },
    { id: "a1", sessionId: "s", ts: 3, type: "assistant_message", payload: { text: bigText } },
  ] as Event[];
  const model = seedHistory(events, false, false);

  const renderOn = async (m: typeof model) => {
    const tty = fakeTty();
    tty.rows = 14; // a terminal shorter than the 20-line answer
    const app = render(
      <History
        model={m}
        sessionKey="s"
        liveStream={undefined}
        streamingEnabled={true}
        reasoningEnabled={false}
      />,
      { stdout: asStdout(tty), patchConsole: false },
    );
    await settle(60);
    app.unmount();
    // ansiEscapes.clearTerminal on POSIX is ESC[2J ESC[3J ESC[H.
    return tty.writes.join("").includes("[2J");
  };

  // The fix: the reducer commits a finished answer straight to <Static>; it never sits in the
  // dynamic region, so a tall answer in a live transcript cannot trip Ink's clearTerminal branch.
  assert.equal(
    model.pending.length,
    0,
    "a finished answer must be committed, not parked in the dynamic region",
  );
  assert.ok(
    !(await renderOn(model)),
    "a committed answer must not trip Ink's clearTerminal branch (the duplicate-answer fix)",
  );

  // The mechanism the fix guards against is real: force the answer back into the dynamic region and
  // a tall one trips clearTerminal, which is what duplicated it into scrollback.
  const answerRow = model.committed.find((r) => r.event.id === "a1");
  if (!answerRow) throw new Error("expected the finished answer in committed");
  const parked = {
    ...model,
    committed: model.committed.filter((r) => r.event.id !== "a1"),
    pending: [answerRow],
  };
  assert.ok(
    await renderOn(parked),
    "a tall answer left in the dynamic region must trip Ink's clearTerminal branch (the bug)",
  );

  // settlePending still recovers that regressed state — the idle safety net for a turn that ends on
  // a trailing row that the per-event reducer did not commit.
  const settled = settlePending(parked);
  assert.equal(settled.pending.length, 0, "settlePending should empty the dynamic region");
  assert.ok(
    !(await renderOn(settled)),
    "a settled answer must not trip Ink's clearTerminal branch",
  );
}

/**
 * The second half of the "duplicate final answer" story. Committing the answer to `<Static>` keeps
 * it out of the dynamic region (see `finishedAnswerCommitsAndDoesNotClear`), but the LIVE tail
 * (reasoning/prose window) still shares the viewport with the chrome below it. If that dynamic
 * region reaches the terminal height Ink takes its `clearTerminal` branch and reprints the whole
 * static transcript — which, on a terminal that ignores ESC[3J (macOS Terminal), duplicates the
 * committed answer into scrollback.
 *
 * The fixed `LIVE_WINDOW_RESERVE` guess underestimates real chrome (a wrapped status roster, a
 * queued/staged indicator): the window is sized too tall and the region overflows. `liveWindowReserve`
 * measures the real chrome instead, so the window shrinks to fit and Ink never clears. This proves
 * both: the fixed reserve clears (the bug) and the computed reserve does not (the fix).
 */
async function computedReserveKeepsLiveRegionUnderViewport() {
  const rows = 18;
  const chromeLines = 10; // e.g. a status roster wrapped across a narrow terminal + indicators
  const answer = Array.from({ length: 30 }, (_, i) => `answer line ${i}`).join("\n");
  const events = [
    { id: "u1", sessionId: "s", ts: 1, type: "user_input", payload: { text: "hi" } },
    { id: "m1", sessionId: "s", ts: 2, type: "model_call_start", payload: { callId: "c1" } },
    { id: "a1", sessionId: "s", ts: 3, type: "assistant_message", payload: { text: answer } },
  ] as Event[];
  const model = seedHistory(events, false, false); // the answer is committed to <Static>
  const live = {
    callId: "c1",
    reasoning: "",
    prose: Array.from({ length: 40 }, (_, i) => `p${i}`).join("\n"),
  };

  const clearsWithReserve = async (reserve: number): Promise<boolean> => {
    const tty = fakeTty();
    tty.rows = rows;
    const budget = liveWindowBudget(rows, {
      proseActive: true,
      reasoningCap: 10,
      proseCap: 12,
      reserve,
    });
    const app = render(
      <Box flexDirection="column">
        <History
          model={model}
          sessionKey="s"
          liveStream={live}
          streamingEnabled={true}
          reasoningEnabled={false}
          proseLines={budget.proseLines}
        />
        <Box flexDirection="column">
          {Array.from({ length: chromeLines }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional chrome lines
            <Text key={i}>{`chrome ${i}`}</Text>
          ))}
        </Box>
      </Box>,
      { stdout: asStdout(tty), patchConsole: false },
    );
    await settle(50);
    app.unmount();
    // ansiEscapes.clearTerminal on POSIX is ESC[2J ESC[3J ESC[H.
    return tty.writes.join("").includes("[2J");
  };

  const computed = liveWindowReserve({
    reasoningHeader: false,
    busyIndicator: false,
    queued: false,
    staged: false,
    structuring: false,
    commandPanelLines: 0,
    statusBarLines: chromeLines,
    inputLines: 0,
    trackerRows: 0,
  });

  assert.ok(
    await clearsWithReserve(LIVE_WINDOW_RESERVE),
    "the fixed reserve underestimates the chrome, so the live region overflows and Ink clears (the bug)",
  );
  assert.ok(
    !(await clearsWithReserve(computed)),
    "the computed reserve fits the chrome under the viewport, so Ink never clears (the fix)",
  );
}

/** The reasoning header is stable and starts compact; Ctrl+R's state flip reveals its bounded tail. */
async function reasoningPanelStartsCollapsed() {
  const model = seedHistory([], true, false);
  const live = { callId: "c1", reasoning: "first thought\nsecond thought", prose: "" };

  const renderReasoning = async (reasoningExpanded: boolean): Promise<string> => {
    const tty = fakeTty();
    const app = render(
      <History
        model={model}
        sessionKey="s"
        liveStream={live}
        streamingEnabled={true}
        reasoningEnabled={true}
        reasoningExpanded={reasoningExpanded}
        reasoningLines={10}
      />,
      { stdout: asStdout(tty), patchConsole: false },
    );
    await settle(50);
    app.unmount();
    return tty.writes.join("");
  };

  const collapsed = await renderReasoning(false);
  assert.ok(
    collapsed.includes("◌ thinking"),
    "live reasoning must use the stable hollow-dot marker",
  );
  assert.ok(collapsed.includes("ctrl+r to expand"), "collapsed header must advertise its toggle");
  assert.ok(!collapsed.includes("first thought"), "collapsed reasoning must hide its tail");

  const expanded = await renderReasoning(true);
  assert.ok(expanded.includes("ctrl+r to collapse"), "expanded header must advertise its toggle");
  assert.ok(expanded.includes("first thought"), "expanded reasoning must show its tail");
}

try {
  await framesAreAtomic();
  await dimensionsAndResize();
  await unsizedPtyDoesNotClear();
  await finishedAnswerCommitsAndDoesNotClear();
  await computedReserveKeepsLiveRegionUnderViewport();
  await reasoningPanelStartsCollapsed();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
