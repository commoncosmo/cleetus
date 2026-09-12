import { expect, test } from "bun:test";
import { formatFindings, parseFindings } from "../../src/agent/review";

const SAMPLE = [
  "[Important] src/pages/ChatPage.tsx:88 — `currentReasoning` is an unused dep",
  "  causing unnecessary re-creations of the callback.",
  "  verified: ran `bun run lint`; oxlint flags it",
  "[Minor] src/App.tsx:16 — closing `</Route>` is over-indented.",
  "  verified: no (static).",
].join("\n");

test("parseFindings normalizes CRLF line endings", () => {
  // A model whose reviewer emits \r\n must still parse — otherwise every line fails the
  // severity/verified regexes and the whole feature silently drops to the raw fallback.
  const crlf = "[Critical] a.ts:1 — boom\r\n  verified: ran `x`\r\n";
  const f = parseFindings(crlf);
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ id: "R1", severity: "Critical", location: "a.ts:1", ran: true });
  expect(f[0]!.description).toBe("boom");
  expect(f[0]!.verified).toBe("ran `x`");
});

test("formatFindings handles CRLF input without stray carriage returns", () => {
  const md = formatFindings("[Minor] a.ts:1 — nit\r\n  verified: no (static)\r\n");
  expect(md).toContain("**R1** · ⚪ Minor · `a.ts:1`");
  expect(md).not.toContain("\r");
});

test("parseFindings extracts fields and assigns positional ids", () => {
  const f = parseFindings(SAMPLE);
  expect(f).toHaveLength(2);
  expect(f[0]).toMatchObject({
    id: "R1",
    severity: "Important",
    location: "src/pages/ChatPage.tsx:88",
    ran: true,
  });
  expect(f[0]!.description).toContain("unused dep");
  expect(f[0]!.description).toContain("re-creations"); // continuation line folded in
  expect(f[1]).toMatchObject({ id: "R2", severity: "Minor", ran: false });
});

test("parseFindings tolerates a line range and a hyphen separator", () => {
  const f = parseFindings("[minor] src/x.tsx:32-41 - indentation drift here");
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ id: "R1", severity: "Minor", location: "src/x.tsx:32-41" });
  expect(f[0]!.description).toBe("indentation drift here");
});

test("parseFindings returns [] when nothing matches", () => {
  expect(parseFindings("I looked at the diff and it seems fine overall.")).toEqual([]);
});

test("formatFindings renders plan-style markdown with ids, emoji, verified, hint", () => {
  const md = formatFindings(SAMPLE);
  expect(md).toContain("## Review — 2 findings");
  expect(md).toContain("**R1** · 🟡 Important · `src/pages/ChatPage.tsx:88`");
  expect(md).toContain("✓ ran `bun run lint`; oxlint flags it");
  expect(md).toContain("**R2** · ⚪ Minor · `src/App.tsx:16`");
  expect(md).toContain("○ no (static).");
  expect(md).toContain("_Reference a finding to act");
});

test("formatFindings uses 🔴 for Critical and singular 'finding'", () => {
  const md = formatFindings("[Critical] a.ts:1 — boom.\n  verified: ran `x`");
  expect(md).toContain("## Review — 1 finding");
  expect(md).toContain("**R1** · 🔴 Critical · `a.ts:1`");
  expect(md).toContain("✓ ran `x`");
});

test("formatFindings clean case", () => {
  expect(formatFindings("No issues found.")).toBe("## Review — no issues found.");
  expect(formatFindings("   ")).toBe("## Review — no issues found.");
});

test("formatFindings preserves raw text on format drift (no ids)", () => {
  const raw = "Honestly the diff looks fine but watch the retry timeout.";
  const md = formatFindings(raw);
  expect(md).toBe(`## Review\n\n${raw}`);
});
