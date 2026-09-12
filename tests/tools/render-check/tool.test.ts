import { expect, test } from "bun:test";
import type { ExecOptions, ExecResult, Sandbox } from "../../../src/sandbox/types";
import {
  RenderCheckTool,
  detectDomAnomaly,
  isBrowserRenderCommand,
  isLocalRenderUrl,
  stripLeadingProjectCd,
} from "../../../src/tools/render-check";
import { BROWSER_DISCOVERY_SNIPPET } from "../../../src/tools/render-check/control-probe";

function fakeSandbox(
  result: Partial<ExecResult>,
  capture?: (options: ExecOptions) => void,
): Sandbox {
  return {
    async exec(_command: string, options: ExecOptions): Promise<ExecResult> {
      capture?.(options);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, cancelled: false, ...result };
    },
    async dispose() {},
    writeRoot() {
      return "/proj";
    },
  };
}

const ctx = {
  projectDir: "/proj",
  abortSignal: new AbortController().signal,
};

const config = { timeoutMs: 12_000, maxOutputLines: 20 };

test("recognizes project-owned browser render commands", () => {
  expect(isBrowserRenderCommand("bunx playwright test")).toBe(true);
  expect(isBrowserRenderCommand("bunx cypress run")).toBe(true);
  expect(isBrowserRenderCommand("bun run test:e2e")).toBe(true);
  expect(isBrowserRenderCommand("bun run build")).toBe(false);
});

test("accepts only local HTTP targets for self-contained rendering", () => {
  expect(isLocalRenderUrl("http://localhost:5173/chat")).toBe(true);
  expect(isLocalRenderUrl("http://127.0.0.1:3000")).toBe(true);
  expect(isLocalRenderUrl("http://localhost:5173/'$(touch nope)")).toBe(false);
  expect(isLocalRenderUrl("https://example.com")).toBe(false);
  expect(isLocalRenderUrl("file:///tmp/index.html")).toBe(false);
});

test("flags a runaway render: one identical leaf element repeated thousands of times", () => {
  const exploded = `<html><body><div id="root">${'<div class="msg"></div>'.repeat(8000)}</div></body></html>`;
  const warning = detectDomAnomaly(exploded);
  expect(warning).not.toBeNull();
  expect(warning).toContain("visual-sanity");
  expect(warning).toContain('<div class="msg">');
  expect(warning).toContain("8,000");
});

test("does not flag a legitimately large list whose items vary", () => {
  // 5,000 list items, each with distinct text — a real list, not a duplicated node.
  const items = Array.from(
    { length: 5000 },
    (_, i) => `<li class="row">Item number ${i}</li>`,
  ).join("");
  expect(detectDomAnomaly(`<html><body><ul>${items}</ul></body></html>`)).toBeNull();
});

test("does not flag many trivially short identical elements", () => {
  // Bare <div></div> and <br> repeated are common and legitimate; only substantial repeats warn.
  const trivial = "<div></div>".repeat(9000);
  expect(detectDomAnomaly(`<html><body>${trivial}</body></html>`)).toBeNull();
});

test("does not flag a modest number of identical elements below the threshold", () => {
  const modest = '<div class="msg">hi</div>'.repeat(500);
  expect(detectDomAnomaly(`<html><body>${modest}</body></html>`)).toBeNull();
});

test("browser discovery honors a CLEETUS_BROWSER override before the default search", () => {
  // The snippet is shared verbatim by the DOM-dump probe and the interactive control probe.
  expect(BROWSER_DISCOVERY_SNIPPET).toContain('if [ -n "$CLEETUS_BROWSER" ]');
  expect(BROWSER_DISCOVERY_SNIPPET).toContain("google-chrome");
  expect(BROWSER_DISCOVERY_SNIPPET).toContain("chromium");
  expect(BROWSER_DISCOVERY_SNIPPET).toContain("CLEETUS_BROWSER_UNAVAILABLE");
  // A shell ${...} here would be a leaked JS interpolation, not a shell expansion.
  expect(BROWSER_DISCOVERY_SNIPPET).not.toContain("${");
});

test("strips a redundant leading cd to the project root from a launch command", () => {
  expect(stripLeadingProjectCd("cd /proj && bun run dev", "/proj")).toBe("bun run dev");
  expect(stripLeadingProjectCd("cd . && bun run dev -- --port 5173", "/proj")).toBe(
    "bun run dev -- --port 5173",
  );
  expect(stripLeadingProjectCd('cd "/proj" && bun run dev', "/proj")).toBe("bun run dev");
  expect(stripLeadingProjectCd("cd /proj; bun run dev", "/proj")).toBe("bun run dev");
});

test("leaves a cd to a different directory (or no cd) intact", () => {
  expect(stripLeadingProjectCd("cd /elsewhere && bun run dev", "/proj")).toBe(
    "cd /elsewhere && bun run dev",
  );
  expect(stripLeadingProjectCd("bun run dev", "/proj")).toBe("bun run dev");
});

test("still rejects a leading cd to a directory other than the project root", async () => {
  let executed = false;
  const tool = new RenderCheckTool(
    fakeSandbox({}, () => {
      executed = true;
    }),
    config,
  );
  const result = await tool.run(
    {
      launchCommand: "cd /elsewhere && bun run dev",
      url: "http://localhost:5173",
      expectedText: "Ready",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("Omit `cd` and shell operators");
  expect(executed).toBe(false);
});

test("rejects shell control operators in a self-contained launch command", async () => {
  let executed = false;
  const tool = new RenderCheckTool(
    fakeSandbox({}, () => {
      executed = true;
    }),
    config,
  );
  const result = await tool.run(
    {
      launchCommand: "bun run dev; touch nope",
      url: "http://localhost:5173",
      expectedText: "Ready",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("Omit `cd` and shell operators");
  expect(executed).toBe(false);
});

test("explains how to use self-contained mode when a dev command is put in command", async () => {
  const tool = new RenderCheckTool(fakeSandbox({}), config);
  const result = await tool.run({ command: "bun run dev", url: "http://localhost:5173" }, ctx);
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("use launchCommand");
  expect(result.errorMessage).toContain("bun run dev -- --port 5173");
});

test("rejects non-browser commands without executing them", async () => {
  let executed = false;
  const tool = new RenderCheckTool(
    fakeSandbox({}, () => {
      executed = true;
    }),
    config,
  );
  const result = await tool.run({ command: "bun run build" }, ctx);
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("existing browser suite");
  expect(executed).toBe(false);
});

test("records a passing browser suite as render evidence", async () => {
  let options: ExecOptions | undefined;
  const tool = new RenderCheckTool(
    fakeSandbox({ stdout: "1 passed" }, (seen) => {
      options = seen;
    }),
    config,
  );
  const result = await tool.run({ command: "bunx playwright test" }, ctx);
  expect(result.ok).toBe(true);
  expect(result.output).toContain("browser render check passed");
  expect(options?.timeoutMs).toBe(12_000);
  expect(options?.cwd).toBe("/proj");
});

test("browser failures and timeouts fail the render check", async () => {
  const failed = await new RenderCheckTool(
    fakeSandbox({ exitCode: 1, stderr: "pageerror: runSync finished async" }),
    config,
  ).run({ command: "bun run test:e2e" }, ctx);
  expect(failed.ok).toBe(false);
  expect(failed.errorMessage).toContain("pageerror");

  const timedOut = await new RenderCheckTool(
    fakeSandbox({ timedOut: true, exitCode: null }),
    config,
  ).run({ command: "bunx cypress run" }, ctx);
  expect(timedOut.ok).toBe(false);
  expect(timedOut.errorMessage).toContain("timed out");
});

test("self-contained mode launches the app and accepts client-rendered DOM", async () => {
  const commands: string[] = [];
  const sandbox: Sandbox = {
    exec(command, options) {
      commands.push(command);
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout: '<html><body><div id="root"><main>Chat ready</main></div></body></html>',
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/chat",
      expectedText: "Chat ready",
    },
    ctx,
  );
  expect(result.ok).toBe(true);
  expect(result.output).toContain("initial browser render check passed");
  expect(result.output).toContain("client-side DOM rendered non-empty content");
  expect(result.output).toContain("matching expected feature text: Chat ready");
  expect(result.output).toContain("stateful interactions not tested");
  expect(result.output).not.toContain("visual-sanity");
  expect(commands).toHaveLength(2);
});

test("passes but appends a visual-sanity warning when the render is a runaway", async () => {
  const exploded = `<html><body><div id="root"><main>Chat ready</main>${'<div class="msg"></div>'.repeat(8000)}</div></body></html>`;
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout: exploded,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/chat",
      expectedText: "Chat ready",
    },
    ctx,
  );
  // The text-presence check still passes; the anomaly is a non-failing caution, not a failure.
  expect(result.ok).toBe(true);
  expect(result.output).toContain("initial browser render check passed");
  expect(result.output).toContain("visual-sanity");
  expect(result.output).toContain("8,000 times identically");
});

test("self-contained mode rejects a non-empty wrong route", async () => {
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout:
          '<html><body><div id="root"><main>Welcome to Ollama Chat. Open Chat from the navigation.</main></div></body></html>',
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/",
      expectedText: "Start a Conversation",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.verificationObserved).toBe(true);
  expect(result.verificationUnavailable).not.toBe(true);
  expect(result.errorMessage).toContain("did not contain expected feature text");
  expect(result.errorMessage).toContain("Welcome to Ollama Chat");
});

test("self-contained control mode rejects an occluded primary control", async () => {
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout:
          'CLEETUS_CONTROL_PROBE:{"observed":true,"expectedTextPresent":true,"controlFound":true,"controlVisible":true,"controlEnabled":true,"controlOccluded":true,"bodyText":"Threads New Thread","detail":"rect=12,38 230x40 viewport=1280x720"}',
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/chat",
      expectedText: "Threads",
      expectedControl: "New Thread",
      expectedAfterText: "Type a message",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.verificationObserved).toBe(true);
  expect(result.errorMessage).toContain("was not usable");
  expect(result.errorMessage).toContain("occluded=true");
});

test("self-contained control mode records a successful primary interaction", async () => {
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout:
          'CLEETUS_CONTROL_PROBE:{"observed":true,"expectedTextPresent":true,"controlFound":true,"controlVisible":true,"controlEnabled":true,"controlOccluded":false,"afterTextPresent":true,"bodyText":"Threads New Thread Type a message","detail":"rect=12,68 230x40 viewport=1280x720"}',
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/chat",
      expectedText: "Threads",
      expectedControl: "New Thread",
      expectedAfterText: "Type a message",
    },
    ctx,
  );
  expect(result.ok).toBe(true);
  expect(result.verificationInteraction).toBe(true);
  expect(result.output).toContain("fully visible, enabled, and unobscured");
  expect(result.output).toContain("clicking it produced: Type a message");
});

// Fake sandbox whose non-dev exec returns a control-probe payload with the given styleReport (and,
// by default, a usable-but-not-clicked page), so the styles verdict can be exercised deterministically.
function styleProbeSandbox(
  styleReport: { utilityElements: number; utilityApplied: number; sampleUnapplied: string },
  extra: Record<string, unknown> = {},
): Sandbox {
  const probe = {
    observed: true,
    expectedTextPresent: true,
    controlFound: false,
    controlVisible: false,
    controlEnabled: false,
    controlOccluded: false,
    bodyText: "Home Welcome",
    detail: "styles/text check (no control requested)",
    styleReport,
    ...extra,
  };
  return {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout: `CLEETUS_CONTROL_PROBE:${JSON.stringify(probe)}`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
}

test("expectStyled fails when layout utility classes are present but produce no computed style", async () => {
  const sandbox = styleProbeSandbox({
    utilityElements: 6,
    utilityApplied: 0,
    sampleUnapplied: ".flex (computed display:block)",
  });
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/",
      expectedText: "Home",
      expectStyled: true,
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.verificationObserved).toBe(true);
  expect(result.errorMessage).toContain("not applying styles");
  expect(result.errorMessage).toContain("@tailwindcss/vite");
  expect(result.errorMessage).toContain(".flex (computed display:block)");
});

test("expectStyled passes and notes coverage when utilities are applied", async () => {
  const sandbox = styleProbeSandbox({
    utilityElements: 6,
    utilityApplied: 5,
    sampleUnapplied: "",
  });
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/",
      expectedText: "Home",
      expectStyled: true,
    },
    ctx,
  );
  expect(result.ok).toBe(true);
  expect(result.output).toContain("5/6 layout utilities verified applied");
});

test("expectStyled does not fail below the sample threshold", async () => {
  // Only 2 utility elements, none applied — too small a sample to condemn; must not false-fail.
  const sandbox = styleProbeSandbox({ utilityElements: 2, utilityApplied: 0, sampleUnapplied: "" });
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/",
      expectedText: "Home",
      expectStyled: true,
    },
    ctx,
  );
  expect(result.ok).toBe(true);
});

test("expectStyled combines with a control interaction and reports both", async () => {
  const sandbox = styleProbeSandbox(
    { utilityElements: 4, utilityApplied: 4, sampleUnapplied: "" },
    {
      controlFound: true,
      controlVisible: true,
      controlEnabled: true,
      controlOccluded: false,
      afterTextPresent: true,
      bodyText: "Home New Thread Type a message",
    },
  );
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/",
      expectedText: "Home",
      expectedControl: "New Thread",
      expectedAfterText: "Type a message",
      expectStyled: true,
    },
    ctx,
  );
  expect(result.ok).toBe(true);
  expect(result.output).toContain("fully visible, enabled, and unobscured");
  expect(result.output).toContain("4/4 layout utilities verified applied");
});

test("rejects a non-boolean expectStyled", async () => {
  let executed = false;
  const tool = new RenderCheckTool(
    fakeSandbox({}, () => {
      executed = true;
    }),
    config,
  );
  const result = await tool.run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/",
      expectedText: "Home",
      expectStyled: "yes",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("expectStyled must be a boolean");
  expect(executed).toBe(false);
});

test("self-contained mode validates expectedText before launching", async () => {
  let executed = false;
  const tool = new RenderCheckTool(
    fakeSandbox({}, () => {
      executed = true;
    }),
    config,
  );
  const result = await tool.run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/chat",
      expectedText: "   ",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("expectedText must be a non-empty string");
  expect(executed).toBe(false);
});

test("self-contained mode rejects non-empty DOM as an assertion", async () => {
  let executed = false;
  const tool = new RenderCheckTool(
    fakeSandbox({}, () => {
      executed = true;
    }),
    config,
  );
  const result = await tool.run(
    { launchCommand: "bun run dev -- --port 5173", url: "http://localhost:5173/chat" },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("requires expectedText distinctive");
  expect(executed).toBe(false);
});

test("self-contained mode reports a missing system browser as unavailable evidence", async () => {
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bunx vite --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout: "",
        stderr: "CLEETUS_BROWSER_UNAVAILABLE",
        exitCode: 69,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bunx vite --port 5173",
      url: "http://localhost:5173",
      expectedText: "Ready",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("could not launch Google Chrome");
  expect(result.errorMessage).toContain("CLEETUS_BROWSER");
  expect(result.verificationUnavailable).toBe(true);
});

test("self-contained mode preserves captured render evidence across forced browser cleanup", async () => {
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout: '<html><body><div id="root"><main>Mira UI</main></div></body></html>',
        stderr: "Chrome cleanup warning",
        exitCode: 143,
        timedOut: true,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173",
      expectedText: "Mira UI",
    },
    ctx,
  );
  expect(result.ok).toBe(true);
  expect(result.verificationUnavailable).not.toBe(true);
  expect(result.output).toContain("initial browser render check passed");
  expect(result.output).toContain("cleanup required forced termination (143)");
  expect(result.output).toContain("stateful interactions not tested");
});

test("a conclusive render passes on the first ready attempt with a bounded per-attempt window", async () => {
  const browserTimeouts: number[] = [];
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      browserTimeouts.push(options.timeoutMs ?? Number.POSITIVE_INFINITY);
      return Promise.resolve({
        stdout: '<html><body><div id="root">Ready</div></body></html>',
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, {
    timeoutMs: 90_000,
    maxOutputLines: 20,
  }).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173",
      expectedText: "Ready",
    },
    ctx,
  );
  expect(result.ok).toBe(true);
  // Content is present on the first attempt, so the poll terminates immediately — no extra probing.
  expect(browserTimeouts).toHaveLength(1);
  // Each single attempt is still bounded so one hung probe cannot consume the whole budget.
  expect(browserTimeouts[0]!).toBeLessThanOrEqual(8_000);
});

test("waits through a not-ready dev server and passes once content renders", async () => {
  let attempts = 0;
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      attempts++;
      // First browser probe hits a cold server → empty DOM; the app renders on a later probe.
      return Promise.resolve(
        attempts >= 2
          ? {
              stdout: '<html><body><div id="root"><main>Chat ready</main></div></body></html>',
              stderr: "",
              exitCode: 0,
              timedOut: false,
              cancelled: false,
            }
          : { stdout: "", stderr: "", exitCode: 0, timedOut: false, cancelled: false },
      );
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, { timeoutMs: 6_000, maxOutputLines: 20 }).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/chat",
      expectedText: "Chat ready",
    },
    ctx,
  );
  expect(result.ok).toBe(true);
  expect(result.output).toContain("matching expected feature text: Chat ready");
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test("reports a never-ready app as inconclusive (unverified), not a failure", async () => {
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      // The dev server never serves content: every probe returns an empty DOM.
      return Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, { timeoutMs: 1_500, maxOutputLines: 20 }).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/chat",
      expectedText: "Chat ready",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.verificationUnavailable).toBe(true);
  expect(result.verificationObserved).not.toBe(true);
  expect(result.errorMessage).toContain("could not verify");
  expect(result.errorMessage).toContain("Recorded as unverified");
});

test("self-contained mode reports browser-visible network failures as page errors", async () => {
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout: '<html><body><div id="root">Chat</div></body></html>',
        stderr: "Failed to load resource: net::ERR_CONNECTION_REFUSED",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173",
      expectedText: "Chat",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("page error: present");
  expect(result.errorMessage).toContain("ERR_CONNECTION_REFUSED");
});

test("self-contained failures distinguish a failed browser from unavailable evidence", async () => {
  const sandbox: Sandbox = {
    exec(command, options) {
      if (command === "bun run dev -- --port 5173") {
        return new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                stdout: "ready",
                stderr: "",
                exitCode: 143,
                timedOut: false,
                cancelled: true,
              }),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        stdout: `<html><body><div id="root"><main>Chat ready</main></div><style>${"x".repeat(20_000)}</style></body></html>`,
        stderr: "browser process crashed",
        exitCode: 15,
        timedOut: false,
        cancelled: false,
      });
    },
    async dispose() {},
    writeRoot: () => "/proj",
  };
  const result = await new RenderCheckTool(sandbox, config).run(
    {
      launchCommand: "bun run dev -- --port 5173",
      url: "http://localhost:5173/chat",
      expectedText: "Chat ready",
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect(result.verificationUnavailable).not.toBe(true);
  expect(result.errorMessage).toContain("rendered DOM: present");
  expect(result.errorMessage).toContain("rendered text: Chat ready");
  expect(result.errorMessage!.length).toBeLessThan(7_000);
});
