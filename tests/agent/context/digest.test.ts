import { describe, expect, it, test } from "bun:test";
import {
  SummaryTimeoutError,
  buildDigestMessage,
  compact,
  extractiveDigest,
  renderSliceForSummary,
} from "../../../src/agent/context/digest";
import type { Message } from "../../../src/providers/types";

const slice: Message[] = [
  { role: "user", content: "make a tauri app" },
  { role: "assistant", content: "created src/index.html" },
];

describe("buildDigestMessage", () => {
  it("is a user-role context note, or null when empty", () => {
    expect(buildDigestMessage("")).toBeNull();
    const m = buildDigestMessage("did stuff");
    expect(m?.role).toBe("user");
    expect(m?.content).toContain("did stuff");
    expect(m?.content.toLowerCase()).toContain("earlier in this session");
    expect(m?.content).toContain("latest user message is the active task");
  });
});

describe("renderSliceForSummary", () => {
  it("omits the 'Existing digest' block when oldText is empty", () => {
    const out = renderSliceForSummary("", slice);
    expect(out).not.toContain("Existing digest");
    expect(out).toContain("Newer messages to fold into the digest:");
  });

  it("includes the prior digest block when oldText is non-empty", () => {
    expect(renderSliceForSummary("prior", slice)).toContain("Existing digest:\nprior");
  });

  it("includes tool calls in rendered messages", () => {
    const withTool: Message[] = [
      {
        role: "assistant",
        content: "ok",
        toolCalls: [{ id: "1", name: "read_file", args: { path: "x.ts" } }],
      },
    ];
    expect(renderSliceForSummary("", withTool)).toContain("tool read_file");
  });
});

const _edit = (path: string): Message => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: "1", name: "edit_file", args: { path } }],
});
const _ran = (command: string): Message => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: "2", name: "bash", args: { command } }],
});

test("extractiveDigest lists edited files and commands, deduped", () => {
  const out = extractiveDigest([_edit("/p/a.ts"), _edit("/p/a.ts"), _ran("cargo build")]);
  expect(out).toContain("/p/a.ts");
  expect(out).toContain("cargo build");
  expect(out.match(/a\.ts/g)!.length).toBe(1); // deduped
});

test("extractiveDigest returns empty string for a slice with nothing to extract", () => {
  expect(extractiveDigest([{ role: "assistant", content: "just text" }])).toBe("");
});

test("compact folds a normal slice in one summarizer call", async () => {
  let calls = 0;
  const r = await compact(
    undefined,
    [_edit("/p/a.ts")],
    1,
    async () => {
      calls++;
      return "summary text";
    },
    { maxSummaryInputTokens: 6000 },
  );
  expect(calls).toBe(1);
  expect(r.state.text).toBe("summary text");
  expect(r.state.coveredThroughIndex).toBe(1);
  expect(r.ok).toBe(true);
  expect(r.partial).toBe(false);
});

test("compact sub-chunks a slice over the token cap", async () => {
  let calls = 0;
  const big = "x".repeat(4000); // ~1000 tokens each
  const slice: Message[] = [
    { role: "assistant", content: big },
    { role: "assistant", content: big },
    { role: "assistant", content: big },
  ];
  const r = await compact(
    undefined,
    slice,
    3,
    async () => {
      calls++;
      return `chunk${calls}`;
    },
    { maxSummaryInputTokens: 1500 },
  );
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(r.ok).toBe(true);
});

test("compact applies one deadline across all summarizer chunks", async () => {
  let calls = 0;
  let firstTimeout: number | undefined;
  const r = await compact(
    undefined,
    [_edit("/p/first.ts"), _edit("/p/second.ts")],
    2,
    async (_old, _chunk, _instruction, timeoutMs) => {
      calls++;
      firstTimeout ??= timeoutMs;
      await Bun.sleep(15);
      return "first chunk";
    },
    { maxSummaryInputTokens: 1, maxElapsedMs: 5 },
  );

  expect(calls).toBe(1);
  expect(firstTimeout).toBeLessThanOrEqual(5);
  expect(r.partial).toBe(true);
  expect(r.state.text).toContain("/p/second.ts");
});

test("compact falls back to extractive digest when summarizer throws, never empty", async () => {
  const r = await compact(
    undefined,
    [_edit("/p/win.rs"), _ran("cargo tree")],
    2,
    async () => {
      throw new Error("timeout");
    },
    { maxSummaryInputTokens: 6000 },
  );
  expect(r.partial).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.state.text).toContain("/p/win.rs");
  expect(r.state.coveredThroughIndex).toBe(2);
});

test("compact retries once before falling back", async () => {
  let attempts = 0;
  const r = await compact(
    undefined,
    [_edit("/p/a.ts")],
    1,
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("first fails");
      return "second ok";
    },
    { maxSummaryInputTokens: 6000 },
  );
  expect(attempts).toBe(2);
  expect(r.state.text).toBe("second ok");
  expect(r.partial).toBe(false);
});

test("compact threads an instruction into the summarizer", async () => {
  let seen: string | undefined;
  await compact(
    undefined,
    [_edit("/p/a.ts")],
    1,
    async (_old, _slice, instruction) => {
      seen = instruction;
      return "x";
    },
    { maxSummaryInputTokens: 6000, instruction: "focus on config" },
  );
  expect(seen).toBe("focus on config");
});

test("compact preserves prior digest text as the base for the first chunk", async () => {
  let firstOld: string | undefined;
  await compact(
    { text: "PRIOR", coveredThroughIndex: 0 },
    [_edit("/p/a.ts")],
    1,
    async (old) => {
      firstOld ??= old;
      return "new";
    },
    { maxSummaryInputTokens: 6000 },
  );
  expect(firstOld).toBe("PRIOR");
});

test("compact does NOT retry a SummaryTimeoutError — one call, then extractive fallback", async () => {
  let calls = 0;
  const r = await compact(
    undefined,
    [_edit("/p/win.rs"), _ran("cargo tree")],
    2,
    async () => {
      calls++;
      throw new SummaryTimeoutError(90000);
    },
    { maxSummaryInputTokens: 6000 },
  );
  expect(calls).toBe(1); // no retry on timeout
  expect(r.partial).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.state.text).toContain("/p/win.rs");
});

test("SummaryTimeoutError carries the timeout and a descriptive message", () => {
  const e = new SummaryTimeoutError(1234);
  expect(e).toBeInstanceOf(Error);
  expect(e.timeoutMs).toBe(1234);
  expect(e.message).toContain("1234");
});

test("degraded compaction retains newest decisions and outcomes when the old digest is full", async () => {
  const messages: Message[] = [
    { role: "user", content: "Collapse thinking when answer content starts." },
    _ran("bun run test"),
    { role: "tool", toolCallId: "2", content: "FAIL restores conversation after reload" },
    _edit("src/new-fix.ts"),
  ];
  const result = await compact(
    { text: "old fact\n".repeat(600), coveredThroughIndex: 10 },
    messages,
    14,
    async () => {
      throw new SummaryTimeoutError(30);
    },
    { maxSummaryInputTokens: 6000 },
  );
  expect(result.state.text.length).toBeLessThanOrEqual(4000);
  expect(result.state.text).toContain("Collapse thinking when answer content starts");
  expect(result.state.text).toContain("FAIL restores conversation after reload");
  expect(result.state.text).toContain("src/new-fix.ts");
  expect(result.state.coveredThroughIndex).toBe(14);
});

test("degraded chunking preserves structured verification and its result across chunk boundaries", async () => {
  const result = await compact(
    undefined,
    [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "build", name: "run_tests", args: { check: "build" } }],
      },
      { role: "tool", toolCallId: "build", content: "build failed: missing property model" },
    ],
    2,
    async () => {
      throw new SummaryTimeoutError(1);
    },
    { maxSummaryInputTokens: 1 },
  );
  expect(result.state.text).toContain('run_tests {"check":"build"}');
  expect(result.state.text).toContain("build failed: missing property model");
});
