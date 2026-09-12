import { resolve } from "node:path";
import type { ExecResult, Sandbox } from "../../sandbox/types";
import { SandboxUnavailableError } from "../../sandbox/types";
import type { Tool, ToolContext, ToolResult } from "../types";
import {
  BROWSER_DISCOVERY_SNIPPET,
  type ControlProbeResult,
  controlProbeCommand,
  parseControlProbe,
} from "./control-probe";

/** The model's common first instinct is `cd <projectDir> && bun run dev …`. The launch already runs
 * from the project root, so a leading `cd` to that root is redundant, not an error — strip it so the
 * first attempt isn't wasted. A leading `cd` to any OTHER directory is left in place (and rejected by
 * the shell-operator guard below). */
export function stripLeadingProjectCd(launchCommand: string, projectDir: string): string {
  const match = launchCommand.match(/^\s*cd\s+(["']?)([^"'\s;&|]+)\1\s*(?:&&|;)\s*(\S.*)$/is);
  if (!match) return launchCommand;
  const target = resolve(projectDir, match[2]!.replace(/^["']|["']$/g, ""));
  return target === resolve(projectDir) ? match[3]!.trim() : launchCommand;
}

/** Overall wall-clock budget for the self-contained readiness poll. A cold dev server plus a
 * client-rendered SPA routinely needs several seconds before its content exists; the old ~6s
 * single-window probe read that as a render failure. Capped by the tool's configured timeout. */
const RENDER_READINESS_BUDGET_MS = 20_000;
/** Upper bound on any single browser attempt so one hung probe cannot consume the whole budget. */
const RENDER_ATTEMPT_CAP_MS = 8_000;
const RENDER_POLL_INTERVAL_MS = 500;

/** The classification of one browser attempt. `not-ready` means the app has not rendered content
 * yet (server still warming, SPA not mounted) — the poll retries these until content appears or the
 * budget elapses. The other three are conclusive: `pass`/`fail` are observed outcomes; `unavailable`
 * means the environment could not run the check (no system browser) and must be recorded as
 * unverified rather than a failure so it never drives a repair loop. */
export type RenderAttemptKind = "pass" | "fail" | "unavailable" | "not-ready";
export interface RenderAttempt {
  kind: RenderAttemptKind;
  detail: string;
  observed?: boolean;
  interaction?: boolean;
  control?: string;
}
export interface RenderProbeMeta {
  launchCommand: string;
  url: string;
  expectedText?: string;
  expectedControl?: string;
  expectedAfterText?: string;
  /** Verify the CSS framework is actually applying — fail if layout utility classes (flex/grid/…)
   *  are present in the DOM but produce no matching computed style (the Tailwind-v4-not-wired case). */
  expectStyled?: boolean;
}

type AttemptResult = Pick<ExecResult, "stdout" | "stderr" | "exitCode" | "timedOut" | "cancelled">;

function browserUnavailable(result: Pick<ExecResult, "stderr" | "exitCode">): boolean {
  return result.exitCode === 69 || result.stderr.includes("CLEETUS_BROWSER_UNAVAILABLE");
}

/** Shown when no headless browser could be launched. Names the CLEETUS_BROWSER override because the
 * common miss is a real Chrome/Chromium the default search can't see (a non-standard install path).
 * On WSL the reliable route is a Linux-side browser inside the distro (`apt`/`snap install chromium`),
 * not the Windows chrome.exe — the latter can't use a Linux --user-data-dir over interop. */
const BROWSER_UNAVAILABLE_DETAIL =
  "render_check could not launch Google Chrome, Chromium, or Microsoft Edge on this system. " +
  "Install one (on WSL/Linux, a Linux-side `chromium` or `google-chrome` inside the distro is the " +
  "reliable choice), or set the CLEETUS_BROWSER environment variable to an executable browser path.";

/** Classify a self-contained DOM-dump attempt. Empty DOM is treated as not-ready (retry): the
 * meaningful failure/pass signals only exist once the client has rendered content. */
export function classifyDumpAttempt(result: AttemptResult, meta: RenderProbeMeta): RenderAttempt {
  if (browserUnavailable(result)) {
    return {
      kind: "unavailable",
      detail: BROWSER_UNAVAILABLE_DETAIL,
    };
  }
  if (!renderedDomHasContent(result.stdout)) {
    return { kind: "not-ready", detail: `no client-rendered DOM yet at ${meta.url}` };
  }
  if (PAGE_ERROR.test(result.stderr)) {
    return { kind: "fail", observed: true, detail: selfContainedFailureDetail(meta.url, result) };
  }
  const expectedTextPresent =
    meta.expectedText === undefined || renderedDomIncludesText(result.stdout, meta.expectedText);
  if (!expectedTextPresent) {
    return {
      kind: "fail",
      observed: true,
      detail: `render_check opened ${meta.url}, but the rendered page did not contain expected feature text: ${meta.expectedText}\nrendered text: ${renderedText(result.stdout) || "(none)"}\nFor input placeholders or accessible labels, use expectedControl together with page heading expectedText. Placeholder text is not body text; its absence here does not prove a timing problem.`,
    };
  }
  const anomaly = detectDomAnomaly(result.stdout);
  const passDetail = `✓ initial browser render check passed\n$ ${meta.launchCommand}\nopened ${meta.url}; client-side DOM rendered non-empty content${meta.expectedText ? ` matching expected feature text: ${meta.expectedText}` : ""} (stateful interactions not tested)${anomaly ? `\n${anomaly}` : ""}`;
  if (result.exitCode === 0) return { kind: "pass", detail: passDetail };
  if (result.exitCode === 143 || result.timedOut || result.cancelled) {
    return {
      kind: "pass",
      detail: `${passDetail}\n⚠ browser cleanup required forced termination (${result.exitCode ?? "unknown"}); captured render evidence remains valid`,
    };
  }
  // Content and expected text are present, but the browser exited abnormally: the evidence is
  // unreliable, so surface it as an observed failure rather than a pass.
  return { kind: "fail", observed: true, detail: selfContainedFailureDetail(meta.url, result) };
}

/** Classify a self-contained interactive control-probe attempt. A missing observation or an empty
 * body is not-ready (retry); everything else is a conclusive pass/fail/unavailable. */
export function classifyControlAttempt(
  probe: ControlProbeResult | null,
  result: Pick<ExecResult, "stderr" | "exitCode">,
  meta: RenderProbeMeta,
): RenderAttempt {
  if (browserUnavailable(result)) {
    return {
      kind: "unavailable",
      detail: BROWSER_UNAVAILABLE_DETAIL,
    };
  }
  if (!probe) {
    return {
      kind: "not-ready",
      detail: `control probe produced no observation yet for ${meta.url}`,
    };
  }
  if (!probe.expectedTextPresent) {
    if (!probe.bodyText.trim()) {
      return { kind: "not-ready", detail: `route not rendered yet at ${meta.url}` };
    }
    return {
      kind: "fail",
      observed: true,
      detail: `render_check opened ${meta.url}, but the rendered page did not contain expected feature text: ${meta.expectedText}\nrendered text: ${probe.bodyText || "(none)"}`,
    };
  }
  // Styles-only / content sanity: with neither text nor control asserted, still require the app to
  // have rendered something before passing, so a blank page cannot slip through as verified.
  if (
    !meta.expectedControl &&
    !meta.expectedText &&
    !probe.bodyText.trim() &&
    !(probe.styleReport && probe.styleReport.utilityElements > 0)
  ) {
    return { kind: "not-ready", detail: `route not rendered yet at ${meta.url}` };
  }
  // Control usability — only assert it when a control interaction was requested.
  if (meta.expectedControl) {
    if (probe.contrastRatio !== undefined && probe.contrastRatio < 1.5) {
      return {
        kind: "fail",
        observed: true,
        detail: `primary control "${meta.expectedControl}" has near-invisible text/placeholder contrast (${probe.contrastRatio.toFixed(2)}:1); inspect foreground, background, theme, and placeholder styles`,
      };
    }
    if (
      !probe.controlFound ||
      !probe.controlVisible ||
      !probe.controlEnabled ||
      probe.controlOccluded
    ) {
      return {
        kind: "fail",
        observed: true,
        detail: `render_check found the route but primary control "${meta.expectedControl}" was not usable (${probe.detail ?? "no geometry detail"}; found=${probe.controlFound}, visible=${probe.controlVisible}, enabled=${probe.controlEnabled}, occluded=${probe.controlOccluded})`,
      };
    }
    if (meta.expectedAfterText && probe.afterTextPresent !== true) {
      return {
        kind: "fail",
        observed: true,
        detail: `render_check clicked "${meta.expectedControl}", but expected result text did not appear: ${meta.expectedAfterText}`,
      };
    }
  }
  // Computed-style sanity — only when requested. Fail if several elements bear layout utility
  // classes (flex/grid/…) but none produce the matching computed style: the CSS framework is not
  // applying. The `utilityApplied === 0` bar is false-positive-proof — any one applied utility clears
  // it — so a correctly-wired page never trips it, while an unstyled page (muse1's Tailwind-v4 miss) does.
  let styleNote = "";
  if (meta.expectStyled) {
    const sr = probe.styleReport;
    if (!sr) return { kind: "not-ready", detail: `style report unavailable yet at ${meta.url}` };
    if (sr.utilityElements >= 3 && sr.utilityApplied === 0) {
      return {
        kind: "fail",
        observed: true,
        detail: `render_check opened ${meta.url}: ${sr.utilityElements} elements use layout utility classes (e.g. ${sr.sampleUnapplied || "flex/grid"}) but none produce the matching computed style — the CSS framework is not applying styles. If this is Tailwind v4, add \`@tailwindcss/vite\` to vite.config plugins (or \`@tailwindcss/postcss\` in a postcss config) and import \`tailwindcss\` in your CSS; do not mask a build error with \`cssMinify:false\`. Otherwise confirm the stylesheet is imported and compiled.`,
      };
    }
    styleNote =
      sr.utilityElements > 0
        ? `; ${sr.utilityApplied}/${sr.utilityElements} layout utilities verified applied`
        : "; no layout utility classes present to verify";
  }
  if (meta.expectedControl) {
    return {
      kind: "pass",
      interaction: meta.expectedAfterText !== undefined,
      control: meta.expectedControl,
      detail: `✓ browser control render check passed\n$ ${meta.launchCommand}\nopened ${meta.url}; matched ${meta.expectedText}; primary control "${meta.expectedControl}" was fully visible, enabled, and unobscured${meta.expectedAfterText ? `; clicking it produced: ${meta.expectedAfterText}` : ""}${styleNote}; text contrast ${probe.contrastRatio === undefined ? "unverified (visual inspection required)" : `${probe.contrastRatio.toFixed(2)}:1`}`,
    };
  }
  return {
    kind: "pass",
    detail: `✓ browser render check passed\n$ ${meta.launchCommand}\nopened ${meta.url}; client-side DOM rendered${meta.expectedText ? ` and matched expected feature text: ${meta.expectedText}` : " non-empty content"}${styleNote}`,
  };
}

/** Map a conclusive attempt to a ToolResult. `unavailable` becomes an inconclusive result flagged
 * verificationUnavailable so the runtime records it as unverified rather than a failed attempt. */
export function renderAttemptToToolResult(attempt: RenderAttempt): ToolResult {
  if (attempt.kind === "pass") {
    return {
      ok: true,
      ...(attempt.interaction ? { verificationInteraction: true } : {}),
      ...(attempt.control ? { verificationControl: attempt.control } : {}),
      output: attempt.detail,
    };
  }
  if (attempt.kind === "unavailable") {
    return {
      ok: false,
      errorCode: "TOOL_FAILED",
      errorMessage: attempt.detail,
      verificationUnavailable: true,
    };
  }
  return {
    ok: false,
    errorCode: "TOOL_FAILED",
    ...(attempt.observed ? { verificationObserved: true } : {}),
    errorMessage: attempt.detail,
  };
}

interface RenderCheckArgs {
  command?: unknown;
  launchCommand?: unknown;
  url?: unknown;
  expectedText?: unknown;
  expectedControl?: unknown;
  expectedAfterText?: unknown;
  expectStyled?: unknown;
}

export interface RenderCheckConfig {
  timeoutMs: number;
  maxOutputLines: number;
}

const BROWSER_TEST_COMMAND =
  /\b(?:bunx\s+(?:playwright\s+test|cypress\s+run)|bun\s+run\s+(?:(?:test:)?(?:e2e|browser|ui)|(?:e2e|browser|ui):test))(?:\s|$)/i;

export function isBrowserRenderCommand(command: string): boolean {
  return BROWSER_TEST_COMMAND.test(command);
}

const LOCAL_LAUNCH_COMMAND =
  /^(?:bunx\s+vite\b|bun\s+run\s+(?:dev|start|preview)(?:\s|$)|bunx\s+(?:astro|next|nuxt)\s+(?:dev|start)(?:\s|$))/i;

export function isLocalRenderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !/[\r\n']/.test(value) &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function renderedDomHasContent(dom: string): boolean {
  if (!/<body\b/i.test(dom)) return false;
  const withoutAssets = dom
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  const root = withoutAssets.match(/<[^>]+\bid=["']root["'][^>]*>([\s\S]*)<\/[^>]+>/i)?.[1] ?? "";
  const visibleText = withoutAssets
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /<\w+\b/.test(root) || visibleText.length > 0;
}

/** Below this many identical leaf elements we never warn — the whole point is to fire only on a
 * near-certain runaway, not a large-but-legitimate list. A page with thousands of BYTE-IDENTICAL
 * leaf elements (same tag, same attributes, same text) is characteristic of a duplicated/recursive
 * render, not real data: real list items vary their text or keys. Deliberately high to stay
 * false-positive-proof. */
const IDENTICAL_ELEMENT_WARN = 2000;
/** Ignore trivially short leaf matches (`<br></br>`, bare `<div></div>`) — a page can legitimately
 * hold many of those; only a substantial repeated element signals a runaway. */
const MIN_ANOMALOUS_ELEMENT_LEN = 15;
// Leaf elements only (text-or-empty content, no nested tags), captured with attributes and text so
// the identity is tag+attrs+text — exactly what a duplicated node repeats byte-for-byte.
const LEAF_ELEMENT_RE = /<([a-zA-Z][\w-]*)((?:\s[^<>]*)?)>([^<>]*)<\/\1>/g;

/** A conservative, non-failing visual-sanity signal: when one identical leaf element repeats
 * thousands of times, the page is almost certainly a runaway/duplicated render (the text-presence
 * check still passes, so this is the only thing that catches a visually-exploded page). Returns a
 * warning line to append to a passing render, or null. Never fails the check — a false positive
 * here would wrongly condemn a legitimate large page, so it only cautions. */
export function detectDomAnomaly(dom: string): string | null {
  const counts = new Map<string, number>();
  let worst: { element: string; count: number } | null = null;
  for (const match of dom.matchAll(LEAF_ELEMENT_RE)) {
    const element = `${match[0]}`.replace(/\s+/g, " ").trim();
    if (element.length < MIN_ANOMALOUS_ELEMENT_LEN) continue;
    const next = (counts.get(element) ?? 0) + 1;
    counts.set(element, next);
    if (!worst || next > worst.count) worst = { element, count: next };
  }
  if (!worst || worst.count < IDENTICAL_ELEMENT_WARN) return null;
  const opening = worst.element.match(/^<[a-zA-Z][\w-]*(?:\s[^<>]*)?>/)?.[0] ?? worst.element;
  return `⚠ visual-sanity: the element \`${opening}\` appears ${worst.count.toLocaleString()} times identically — likely a runaway/duplicated render, not a real list. Verify the page isn't visually exploded.`;
}

const SYSTEM_BROWSER_COMMAND = String.raw`${BROWSER_DISCOVERY_SNIPPET}
# Keep the disposable profile under the user's cache dir, not /tmp: a strictly confined snap browser
# (the default Chromium on recent Ubuntu/WSL) cannot write a --user-data-dir under /tmp, only within
# $HOME. Fall back to /tmp only if the cache dir is unusable.
cache="$XDG_CACHE_HOME"
if [ -z "$cache" ]; then cache="$HOME/.cache"; fi
if ! mkdir -p "$cache" 2>/dev/null; then cache="$TMPDIR"; fi
if [ -z "$cache" ]; then cache="/tmp"; fi
profile=$(mktemp -d "$cache/cleetus-render.XXXXXX" 2>/dev/null) || profile=$(mktemp -d)
trap 'rm -rf "$profile"' EXIT
"$browser" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --enable-logging=stderr --user-data-dir="$profile" --virtual-time-budget=2000 --dump-dom`;

const PAGE_ERROR =
  /\b(?:Uncaught|ReferenceError|TypeError|SyntaxError):|Access to fetch\b[^\n]*blocked by CORS|Failed to load resource|net::ERR_/i;

function capOutput(text: string, maxLines: number): string {
  const lines = text.trimEnd().split("\n");
  const lineCapped =
    lines.length <= maxLines
      ? lines.join("\n")
      : (() => {
          const head = Math.ceil(maxLines / 2);
          const tail = maxLines - head;
          return `${lines.slice(0, head).join("\n")}\n…${lines.length - maxLines} lines omitted…\n${lines.slice(-tail).join("\n")}`;
        })();
  const maxChars = 6_000;
  if (lineCapped.length <= maxChars) return lineCapped;
  const headChars = Math.ceil(maxChars / 2);
  const tailChars = maxChars - headChars;
  return `${lineCapped.slice(0, headChars)}\n…${lineCapped.length - maxChars} characters omitted…\n${lineCapped.slice(-tailChars)}`;
}

function renderedVisibleText(dom: string): string {
  return dom
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderedText(dom: string): string {
  return renderedVisibleText(dom).slice(0, 1_000);
}

function renderedDomIncludesText(dom: string, expectedText: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  return normalize(renderedVisibleText(dom)).includes(normalize(expectedText));
}

function selfContainedFailureDetail(
  url: string,
  result: Awaited<ReturnType<Sandbox["exec"]>> | undefined,
): string {
  if (!result) return `render_check did not receive a browser result for ${url}`;
  const hasDom = renderedDomHasContent(result.stdout);
  const pageErrors = result.stderr
    .split("\n")
    .filter((line) => PAGE_ERROR.test(line))
    .join("\n");
  const summary = [
    `render_check failed for ${url}`,
    `browser exit: ${result.exitCode ?? "unknown"}; rendered DOM: ${hasDom ? "present" : "absent"}; page error: ${pageErrors ? "present" : "absent"}`,
  ];
  const visible = renderedText(result.stdout);
  if (visible) summary.push(`rendered text: ${visible}`);
  if (pageErrors) summary.push(`page errors:\n${capOutput(pageErrors, 12)}`);
  if (result.stderr.trim()) summary.push(`browser diagnostics:\n${capOutput(result.stderr, 20)}`);
  return summary.join("\n");
}

/** Run either a project-owned browser suite or a disposable host-owned headless-browser probe.
 * The latter launches the existing app command without adding files or dependencies to the
 * project, then verifies that client-side rendering produced non-empty DOM. */
export class RenderCheckTool implements Tool {
  name = "render_check";
  mutates = true;
  description =
    "Verify that a web UI actually renders. Either provide command for an existing Playwright, " +
    "Cypress, or browser/e2e suite, or provide launchCommand plus a localhost url for Cleetus to " +
    "launch the app and inspect its rendered DOM with an available system browser. The " +
    "self-contained mode requires distinctive visible text so the wrong route cannot pass. " +
    "It can also verify a named primary control is visible/unobscured and click it when " +
    "expectedControl and expectedAfterText are provided, and (with expectStyled) verify the CSS " +
    "framework actually applies styles rather than only rendering text. It does not " +
    "add files or dependencies to the project.";
  parameters = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Existing browser test command, such as bunx playwright test",
      },
      launchCommand: {
        type: "string",
        description:
          "Existing Bun dev command, such as bun run dev -- --port 5173. It already runs from the project root; do not prefix cd or use shell operators.",
      },
      url: { type: "string", description: "Local HTTP page opened after launchCommand starts" },
      expectedText: {
        type: "string",
        description:
          "Distinctive visible text required on the rendered feature route. Use this in self-contained mode so a generic landing page cannot satisfy the check.",
      },
      // TODO(render-check #3): add `expectedTestId` and assert on a stable [data-testid] selector
      // instead of only guessed visible text; see docs/render-check-next-pass.md.
      // TODO(render-check #4): launch the dev server once per turn and reuse it across probes rather
      // than relaunching it inside runSelfContained on every call.
      expectedControl: {
        type: "string",
        description:
          "Accessible name, label, title, placeholder, or visible text of a primary control that must be fully visible, enabled, and unobscured.",
      },
      expectedAfterText: {
        type: "string",
        description:
          "Optional text that must appear after Cleetus clicks expectedControl. Use for the primary interaction on stateful UI routes.",
      },
      expectStyled: {
        type: "boolean",
        description:
          "Set true for a styled UI (Tailwind/shadcn/CSS framework) to verify styles actually apply: render_check fails if layout utility classes (flex/grid) are present but produce no matching computed style — catches a page that renders text but is visually unstyled (e.g. Tailwind v4 with no @tailwindcss/vite plugin). Text presence alone does not prove styling.",
      },
    },
    additionalProperties: false,
  };

  constructor(
    private readonly sandbox: Sandbox,
    private readonly cfg: RenderCheckConfig,
  ) {}

  serialize(args: unknown): string {
    const command = (args as RenderCheckArgs | undefined)?.command;
    const launchCommand = (args as RenderCheckArgs | undefined)?.launchCommand;
    const url = (args as RenderCheckArgs | undefined)?.url;
    const expectedText = (args as RenderCheckArgs | undefined)?.expectedText;
    if (typeof command === "string") return command;
    if (typeof launchCommand === "string" && typeof url === "string") {
      return `${launchCommand} → ${url}${typeof expectedText === "string" ? ` (expects ${expectedText})` : ""}`;
    }
    return "render_check(?)";
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as RenderCheckArgs;
    const command = input.command;
    const launchCommand = input.launchCommand;
    const url = input.url;
    const expectedText = input.expectedText;
    const expectedControl = input.expectedControl;
    const expectedAfterText = input.expectedAfterText;
    const expectStyled = input.expectStyled;
    if (typeof command !== "string") {
      if (typeof launchCommand !== "string" || typeof url !== "string") {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage:
            "render_check requires either command, or both launchCommand and a localhost url",
        };
      }
      if (
        expectedText !== undefined &&
        (typeof expectedText !== "string" || !expectedText.trim())
      ) {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: "render_check expectedText must be a non-empty string when provided",
        };
      }
      if (expectedText === undefined) {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage:
            "self-contained render_check requires expectedText distinctive to the intended feature route; non-empty DOM alone is not render evidence",
        };
      }
      if (
        expectedControl !== undefined &&
        (typeof expectedControl !== "string" || !expectedControl.trim())
      ) {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: "render_check expectedControl must be a non-empty string when provided",
        };
      }
      if (
        expectedAfterText !== undefined &&
        (typeof expectedAfterText !== "string" || !expectedAfterText.trim())
      ) {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: "render_check expectedAfterText must be a non-empty string when provided",
        };
      }
      if (expectedAfterText !== undefined && expectedControl === undefined) {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: "render_check expectedAfterText requires expectedControl",
        };
      }
      if (expectStyled !== undefined && typeof expectStyled !== "boolean") {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: "render_check expectStyled must be a boolean when provided",
        };
      }
      return this.runSelfContained(
        launchCommand,
        url,
        typeof expectedText === "string" ? expectedText.trim() : undefined,
        typeof expectedControl === "string" ? expectedControl.trim() : undefined,
        typeof expectedAfterText === "string" ? expectedAfterText.trim() : undefined,
        expectStyled === true,
        ctx,
      );
    }
    if (!isBrowserRenderCommand(command)) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "The command field is only for an existing browser suite (for example `bunx playwright test`). To launch the app without a suite, use launchCommand: `bun run dev -- --port 5173` together with url: `http://localhost:5173`.",
      };
    }
    if (/\b(?:add|install|create)\b/i.test(command)) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "render_check cannot install or create disposable browser-test infrastructure",
      };
    }

    let result: Awaited<ReturnType<Sandbox["exec"]>>;
    try {
      result = await this.sandbox.exec(command, {
        cwd: ctx.projectDir,
        timeoutMs: this.cfg.timeoutMs,
        signal: ctx.abortSignal,
      });
    } catch (error) {
      const message =
        error instanceof SandboxUnavailableError ? error.message : (error as Error).message;
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: message,
        verificationUnavailable: error instanceof SandboxUnavailableError,
      };
    }

    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.cancelled) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "render_check cancelled" };
    }
    if (result.timedOut) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: `render_check timed out after ${this.cfg.timeoutMs}ms\n${capOutput(combined, this.cfg.maxOutputLines)}`,
      };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: `render_check exited with code ${result.exitCode ?? "unknown"}\n${capOutput(combined, this.cfg.maxOutputLines)}`,
      };
    }
    return {
      ok: true,
      verificationInteraction: true,
      output: `✓ browser render check passed\n$ ${command}${combined.trim() ? `\n${capOutput(combined, this.cfg.maxOutputLines)}` : ""}`,
    };
  }

  private async runSelfContained(
    rawLaunchCommand: string,
    url: string,
    expectedText: string | undefined,
    expectedControl: string | undefined,
    expectedAfterText: string | undefined,
    expectStyled: boolean,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const launchCommand = stripLeadingProjectCd(rawLaunchCommand, ctx.projectDir);
    if (/[;&|`\r\n]/.test(launchCommand)) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "launchCommand already runs from the project root. Omit `cd` and shell operators; use a direct command such as `bun run dev -- --port 5173`.",
      };
    }
    if (/\b(?:add|install|create)\b/i.test(launchCommand)) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "launchCommand cannot install or create verification infrastructure; use an existing project dev or preview script",
      };
    }
    if (!LOCAL_LAUNCH_COMMAND.test(launchCommand.trim())) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage:
          "launchCommand must be a direct existing Bun dev/preview command, for example `bun run dev -- --port 5173` or `bunx vite --port 5173`",
      };
    }
    if (!isLocalRenderUrl(url)) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: "self-contained render_check only opens an http://localhost URL",
      };
    }

    const serverAbort = new AbortController();
    const onAbort = () => serverAbort.abort();
    if (ctx.abortSignal.aborted) serverAbort.abort();
    else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
    let serverResult: Awaited<ReturnType<Sandbox["exec"]>> | undefined;
    const serverPromise = this.sandbox
      .exec(launchCommand, {
        cwd: ctx.projectDir,
        timeoutMs: this.cfg.timeoutMs,
        signal: serverAbort.signal,
      })
      .then((result) => {
        serverResult = result;
        return result;
      });

    try {
      await new Promise((resolve) => setTimeout(resolve, 750));
      if (serverResult && serverResult.exitCode !== 0) {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: `render server exited before browser verification\n${capOutput(
            [serverResult.stdout, serverResult.stderr].filter(Boolean).join("\n"),
            this.cfg.maxOutputLines,
          )}`,
        };
      }
      const meta: RenderProbeMeta = {
        launchCommand,
        url,
        expectedText,
        expectedControl,
        expectedAfterText,
        expectStyled,
      };
      // The CDP probe (real browser, getComputedStyle) is needed for the styles check, so route to it
      // when a control interaction OR a styles check is requested; otherwise the lighter DOM dump.
      const useControlProbe = Boolean(expectedControl) || expectStyled;
      // Poll until an attempt is conclusive (pass/fail/unavailable) or the readiness budget elapses.
      // A `not-ready` attempt means the app has not rendered content yet — retry rather than
      // reporting a spurious failure, which is what let a cold dev server read as broken.
      const budgetMs = Math.min(this.cfg.timeoutMs, RENDER_READINESS_BUDGET_MS);
      const deadline = Date.now() + budgetMs;
      let lastNotReady = `the app did not render content at ${url}`;
      while (Date.now() < deadline) {
        if (serverResult && serverResult.exitCode !== 0) {
          return {
            ok: false,
            errorCode: "TOOL_FAILED",
            errorMessage: `render server exited before browser verification\n${capOutput(
              [serverResult.stdout, serverResult.stderr].filter(Boolean).join("\n"),
              this.cfg.maxOutputLines,
            )}`,
          };
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const browserCommand = useControlProbe
          ? controlProbeCommand({
              url,
              expectedText,
              expectedControl,
              expectedAfterText,
            })
          : `${SYSTEM_BROWSER_COMMAND} '${url}'`;
        const last = await this.sandbox.exec(browserCommand, {
          cwd: ctx.projectDir,
          timeoutMs: Math.max(1_000, Math.min(remainingMs, RENDER_ATTEMPT_CAP_MS)),
          signal: ctx.abortSignal,
        });
        const attempt = useControlProbe
          ? classifyControlAttempt(parseControlProbe(last.stdout), last, meta)
          : classifyDumpAttempt(last, meta);
        if (attempt.kind !== "not-ready") return renderAttemptToToolResult(attempt);
        lastNotReady = attempt.detail;
        if (Date.now() + RENDER_POLL_INTERVAL_MS >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, RENDER_POLL_INTERVAL_MS));
      }
      // The app never rendered content within the budget. This is inconclusive, not a failure: the
      // dev server may not have become ready. Flag it verificationUnavailable so the runtime records
      // it as unverified rather than a failed attempt that drives repair loops.
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        verificationUnavailable: true,
        errorMessage: `render_check could not verify ${url}: ${lastNotReady} within ${budgetMs}ms. The dev server may not have become ready or the app did not mount. Recorded as unverified (not a failure); confirm the app renders manually, adjust the launchCommand/url, or add a browser test suite.`,
      };
    } catch (error) {
      const message =
        error instanceof SandboxUnavailableError ? error.message : (error as Error).message;
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: message,
        verificationUnavailable: error instanceof SandboxUnavailableError,
      };
    } finally {
      serverAbort.abort();
      await serverPromise.catch(() => undefined);
      ctx.abortSignal.removeEventListener("abort", onAbort);
    }
  }
}
