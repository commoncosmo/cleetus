import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";
import { EditorPermissionPrompt } from "../../../src/ui/tui/editor-permission-prompt";
import { EffortPickerModal } from "../../../src/ui/tui/effort-picker-modal";
import { Input, type Suggestion } from "../../../src/ui/tui/input";
import { ModePickerModal } from "../../../src/ui/tui/mode-picker-modal";
import { PermissionPrompt } from "../../../src/ui/tui/permission-prompt";
import { BuildPrompt } from "../../../src/ui/tui/plan-or-go-prompt";
import { RestorePrompt } from "../../../src/ui/tui/restore-prompt";
import { SpecExecutionPrompt } from "../../../src/ui/tui/spec-execution-prompt";
import { WorkflowPermissionPrompt } from "../../../src/ui/tui/workflow-permission-prompt";

/**
 * Real-Ink keyboard probe for menu navigation. Ink's frame path is disabled under CI, but the
 * final frame is still written on unmount, so asserting on the accumulated writes works in both
 * modes (same trick as ink-proxy-probe.tsx, minus the separate process).
 */
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

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function withInk(element: ReactElement, drive: (stdin: PassThrough) => Promise<void>) {
  const tty = fakeTty();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const app = render(element, {
    stdout: tty as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  try {
    await settle();
    await drive(stdin);
    await settle();
  } finally {
    app.unmount();
    stdin.destroy();
  }
  return tty.writes.join("");
}

/**
 * Which row the "› " marker points at in the LAST rendered frame. Ink erases and repaints on each
 * keystroke, so scanning the whole write log would match a stale earlier frame; split on the
 * cursor-to-column escape Ink emits before every repaint and keep only the tail. Picker rows carry
 * an extra "* "/"  " active-marker column after the cursor, so match on the marked line's text.
 */
function highlighted(output: string, labels: string[]): string | null {
  const frames = output.split("\u001b[G");
  const last = frames[frames.length - 1] ?? "";
  const marked = last.split("\n").find((line) => line.startsWith("› "));
  if (!marked) return null;
  // Word-boundary match: a plain substring test would let "low" match inside "slower".
  for (const label of labels) {
    if (new RegExp(`(^|\\s)${label.replace(/[/]/g, "\\$&")}(\\s|$)`).test(marked)) return label;
  }
  return null;
}

const CTRL_N = "\u000e";
const CTRL_P = "\u0010";

const EFFORT_LABELS = ["low", "medium", "high", "xhigh"];

test("ctrl+n and ctrl+p move the picker selection like the arrow keys", async () => {
  const output = await withInk(
    <EffortPickerModal active="low" onSelect={() => {}} onCancel={() => {}} />,
    async (stdin) => {
      stdin.write(CTRL_N);
      await settle();
      stdin.write(CTRL_N);
      await settle();
    },
  );
  // low → medium → high
  expect(highlighted(output, EFFORT_LABELS)).toBe("high");
});

test("ctrl+p walks the picker selection back toward the top and clamps", async () => {
  const output = await withInk(
    <EffortPickerModal active="xhigh" onSelect={() => {}} onCancel={() => {}} />,
    async (stdin) => {
      stdin.write(CTRL_P);
      await settle();
      stdin.write(CTRL_P);
      await settle();
      stdin.write(CTRL_P);
      await settle();
      stdin.write(CTRL_P);
      await settle();
    },
  );
  // xhigh → high → medium → low → low (clamped at the first row)
  expect(highlighted(output, EFFORT_LABELS)).toBe("low");
});

test("ctrl+n and ctrl+p move the slash-command suggestion selection", async () => {
  const suggestions: Suggestion[] = [
    { display: "/help", value: "/help" },
    { display: "/history", value: "/history" },
    { display: "/hooks", value: "/hooks" },
  ];
  const output = await withInk(
    <Input prompt="cleetus>" onSubmit={() => {}} complete={() => suggestions} />,
    async (stdin) => {
      stdin.write("/");
      await settle();
      stdin.write(CTRL_N);
      await settle();
    },
  );
  expect(highlighted(output, ["/help", "/history", "/hooks"])).toBe("/history");
});

test("ctrl+p in the suggestion list returns to the previous suggestion", async () => {
  const suggestions: Suggestion[] = [
    { display: "/help", value: "/help" },
    { display: "/history", value: "/history" },
    { display: "/hooks", value: "/hooks" },
  ];
  const output = await withInk(
    <Input prompt="cleetus>" onSubmit={() => {}} complete={() => suggestions} />,
    async (stdin) => {
      stdin.write("/");
      await settle();
      stdin.write(CTRL_N);
      await settle();
      stdin.write(CTRL_N);
      await settle();
      stdin.write(CTRL_P);
      await settle();
    },
  );
  expect(highlighted(output, ["/help", "/history", "/hooks"])).toBe("/history");
});

test("the chords never leak into the input buffer as literal text", async () => {
  const submitted: string[] = [];
  const output = await withInk(
    <Input prompt="cleetus>" onSubmit={(v) => submitted.push(v)} />,
    async (stdin) => {
      // No suggestions are open here, so the chords must be inert rather than typed.
      stdin.write(CTRL_N);
      await settle();
      stdin.write(CTRL_P);
      await settle();
      stdin.write("\r");
      await settle();
    },
  );
  expect(submitted).toEqual([""]);
  expect(output).not.toContain("cleetus> n");
  expect(output).not.toContain("cleetus> p");
});

test("ctrl+n clamps at the last suggestion instead of wrapping", async () => {
  const suggestions: Suggestion[] = [
    { display: "/help", value: "/help" },
    { display: "/history", value: "/history" },
  ];
  const output = await withInk(
    <Input prompt="cleetus>" onSubmit={() => {}} complete={() => suggestions} />,
    async (stdin) => {
      stdin.write("/");
      await settle();
      for (let i = 0; i < 4; i++) {
        stdin.write(CTRL_N);
        await settle();
      }
    },
  );
  expect(highlighted(output, ["/help", "/history"])).toBe("/history");
});

/**
 * Ctrl+N/Ctrl+P are now menu chords, so a prompt that reads a bare letter must not mistake the
 * chord for that letter. Ink hands the chord through as input "n"/"p" WITH ctrl set, so these
 * prompts must gate on the modifier — the same guard bootstrap-location-prompt.tsx already uses.
 */
test("ctrl+n does not cancel the editor-permission prompt as if it were a typed n", async () => {
  const resolved: boolean[] = [];
  await withInk(
    <EditorPermissionPrompt
      editor="vim"
      targets={["/tmp/x"]}
      onResolve={(v) => resolved.push(v)}
    />,
    async (stdin) => {
      stdin.write(CTRL_N);
      await settle();
    },
  );
  expect(resolved).toEqual([]);
});

test("ctrl+n does not deny the workflow-permission prompt as if it were a typed n", async () => {
  const decisions: string[] = [];
  const request = {
    plan: {
      package: {
        name: "demo",
        manifest: { revision: 1 },
        executionHash: "0123456789abcdef",
      },
    },
    dryRun: { summary: "step 1: run" },
  } as never;
  await withInk(
    <WorkflowPermissionPrompt request={request} onResolve={(d) => decisions.push(d)} />,
    async (stdin) => {
      stdin.write(CTRL_N);
      await settle();
    },
  );
  expect(decisions).toEqual([]);
});

test("ctrl+p does not choose plan in the build prompt as if it were a typed p", async () => {
  const chosen: string[] = [];
  await withInk(
    <BuildPrompt
      showOrchestrate={false}
      onOrchestrate={() => chosen.push("orchestrate")}
      onRepair={() => chosen.push("repair")}
      onPlan={() => chosen.push("plan")}
      onGo={() => chosen.push("go")}
      onCancel={() => chosen.push("cancel")}
    />,
    async (stdin) => {
      stdin.write(CTRL_P);
      await settle();
    },
  );
  expect(chosen).toEqual([]);
});

test("ctrl+n does not dismiss the restore prompt as if it were a typed n", async () => {
  const actions: string[] = [];
  await withInk(
    <RestorePrompt
      snapshot={{ todos: [], updatedAt: Date.now() } as never}
      onRestore={() => actions.push("restore")}
      onDismiss={() => actions.push("dismiss")}
    />,
    async (stdin) => {
      stdin.write(CTRL_N);
      await settle();
    },
  );
  expect(actions).toEqual([]);
});

test("ctrl+n does not deny the permission prompt as if it were a typed n", async () => {
  const actions: string[] = [];
  await withInk(
    <PermissionPrompt tool="bash" summary="ls" onResolve={(a) => actions.push(String(a))} />,
    async (stdin) => {
      stdin.write(CTRL_N);
      await settle();
    },
  );
  expect(actions).toEqual([]);
});

test("ctrl+n does not cancel the dangerous-mode confirmation as if it were a typed n", async () => {
  const actions: string[] = [];
  await withInk(
    <ModePickerModal
      initial={"fuckit" as never}
      onSelect={(m) => actions.push(`select:${m}`)}
      onCancel={() => actions.push("cancel")}
    />,
    async (stdin) => {
      stdin.write(CTRL_N);
      await settle();
    },
  );
  expect(actions).toEqual([]);
});

test("ctrl+p does not choose plan in the accepted-spec chooser as if it were a typed p", async () => {
  const actions: string[] = [];
  await withInk(
    <SpecExecutionPrompt
      orchestrationAvailable={false}
      orchestrationRetry={false}
      onPlan={() => actions.push("plan")}
      onOrchestrate={() => actions.push("orchestrate")}
      onRepair={() => actions.push("repair")}
      onGo={() => actions.push("go")}
      onCancel={() => actions.push("cancel")}
    />,
    async (stdin) => {
      stdin.write(CTRL_P);
      await settle();
    },
  );
  expect(actions).toEqual([]);
});
