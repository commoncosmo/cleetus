import { describe, expect, it, test } from "bun:test";
import {
  type DigestState,
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
  expect(r.state.text).toContain("summary text");
  expect(r.state.text).toContain("/p/a.ts");
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
  expect(r.state.text).toContain("second ok");
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

test("Ripple documentation, requested framework, and compiler errors survive repeated degraded compaction", async () => {
  const messages: Message[] = [
    { role: "user", content: "Create a Vite/TypeScript site with Ripple for the UI." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "docs",
          name: "web_fetch",
          args: { url: "https://www.ripple-ts.com/llms.txt", query: "track" },
        },
      ],
    },
    { role: "tool", toolCallId: "docs", content: "external manual\n".repeat(5000) },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "build", name: "run_tests", args: { check: "build" } }],
    },
    {
      role: "tool",
      toolCallId: "build",
      content:
        "build failed\nsrc/counter.test.ts TS2307 Cannot find module 'vitest'\nsrc/main.ts TS2307 Cannot find module './App.tsrx'\nsrc/main.ts TS2322 HTMLElement | null",
    },
  ];
  const timeout = async () => {
    throw new SummaryTimeoutError(30);
  };
  let result = await compact(undefined, messages, 5, timeout, { maxSummaryInputTokens: 1000 });
  for (let i = 0; i < 5; i++) {
    result = await compact(
      result.state,
      Array.from({ length: 35 }, (_, j) => _edit(`src/other-${i}-${j}.ts`)),
      40 + i * 35,
      timeout,
      { maxSummaryInputTokens: 6000 },
    );
  }
  expect(result.state.text).toContain("site with Ripple");
  expect(result.state.text).toContain("https://www.ripple-ts.com/llms.txt");
  expect(result.state.text).toContain("reuse web_fetch query/start_line");
  expect(result.state.text).toContain("Cannot find module 'vitest'");
  expect(result.state.text).toContain("HTMLElement | null");
  expect(result.state.text).not.toContain("external manual");
  expect(result.state.text.length).toBeLessThanOrEqual(4000);
});

test("deterministic check evidence survives a successful but incomplete summary and updates on repair", async () => {
  const failed = await compact(
    undefined,
    [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "b", name: "run_tests", args: { check: "build" } }],
      },
      { role: "tool", toolCallId: "b", content: "TS2307 Cannot find module './App.tsrx'" },
    ],
    2,
    async () => "Working on the UI",
    { maxSummaryInputTokens: 6000 },
  );
  expect(failed.state.text).toContain("TS2307");
  const repaired = await compact(
    failed.state,
    [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "b2", name: "run_tests", args: { check: "build" } }],
      },
      { role: "tool", toolCallId: "b2", content: "✓ build passed" },
    ],
    4,
    async () => "Repaired the UI",
    { maxSummaryInputTokens: 6000 },
  );
  expect(repaired.state.text).toContain("build passed");
  expect(repaired.state.text).not.toContain("TS2307");
});

test("documentation searches do not supersede actual build diagnostics", async () => {
  const result = await compact(
    undefined,
    [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "b",
            name: "bash",
            args: { command: "npm run build 2>&1 | Select-Object -First 60" },
          },
        ],
      },
      { role: "tool", toolCallId: "b", content: "TS2307 Cannot find module './App.tsrx'" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "search",
            name: "bash",
            args: { command: "Select-String -Path ripple.txt -Pattern 'build'" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "search",
        content: "The build section describes the Vite plugin",
      },
    ],
    4,
    async () => "Looked into the build",
    { maxSummaryInputTokens: 6000 },
  );
  expect(result.state.recoveryFacts?.["check:build"]).toContain("TS2307");
  expect(result.state.recoveryFacts?.["check:build"]).not.toContain("Select-String");
});

test("does not duplicate the caller's verbatim active request during degraded compaction", async () => {
  const request = "Create a Vite/TypeScript site with Ripple";
  const result = await compact(
    undefined,
    [{ role: "user", content: request }, _edit("src/App.tsrx")],
    2,
    async () => {
      throw new SummaryTimeoutError(30);
    },
    { maxSummaryInputTokens: 6000, activeRequest: request },
  );
  expect(result.state.text).not.toContain(request);
  expect(result.state.text).toContain("src/App.tsrx");
});

test("repeated failed summaries back off for three compactions, then probe the summarizer again", async () => {
  let calls = 0;
  let state: DigestState | undefined;
  const summarize = async () => {
    calls++;
    throw new SummaryTimeoutError(30);
  };
  for (let i = 1; i <= 5; i++) {
    const result = await compact(state, [_edit(`src/file-${i}.ts`)], i, summarize, {
      maxSummaryInputTokens: 6000,
      summaryKey: "strata:iq3_s",
    });
    state = result.state;
    expect(result.partial).toBe(true);
    expect(result.skippedSummary).toBe(i >= 3);
    expect(state.text).toContain(`file-${i}.ts`);
  }
  expect(calls).toBe(2);
  expect(state?.coveredThroughIndex).toBe(5);
  state = (
    await compact(state, [_edit("src/probe.ts")], 6, summarize, {
      maxSummaryInputTokens: 6000,
      summaryKey: "strata:iq3_s",
    })
  ).state;
  expect(calls).toBe(3);
  await compact(
    state,
    [_edit("src/new-model.ts")],
    7,
    async () => {
      calls++;
      return "new model recovered";
    },
    { maxSummaryInputTokens: 6000, summaryKey: "other:model" },
  );
  expect(calls).toBe(4);
  const manual = await compact(
    state,
    [_edit("src/manual.ts")],
    7,
    async () => {
      calls++;
      return "manual retry";
    },
    { maxSummaryInputTokens: 6000, summaryKey: "strata:iq3_s", forceSummary: true },
  );
  expect(calls).toBe(5);
  expect(manual.partial).toBe(false);
  expect(manual.state.summaryFailures).toBe(0);
});
