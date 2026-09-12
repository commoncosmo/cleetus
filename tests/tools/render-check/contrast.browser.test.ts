import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoneSandbox } from "../../../src/sandbox/none";
import {
  controlProbeCommand,
  parseControlProbe,
} from "../../../src/tools/render-check/control-probe";
import { classifyControlAttempt } from "../../../src/tools/render-check/tool";

// Opt in when a supported browser is installed. Exercises the actual generated CDP script,
// including placeholder pseudo-element styles; fake DOM-presence results cannot pass this test.
test.skipIf(process.env.CLEETUS_BROWSER_SMOKE !== "1")(
  "real browser distinguishes invisible placeholder text from visible controls",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "contrast-browser-"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const low = new URL(request.url).pathname === "/low";
        return new Response(
          `<html><head><style>body,input{background:white} input::placeholder{color:${low ? "white" : "black"};opacity:1}input{width:240px;height:40px}</style></head><body><h1>Chat</h1><input placeholder="Type a message"></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    try {
      for (const low of [true, false]) {
        const url = `http://127.0.0.1:${server.port}/${low ? "low" : "good"}`;
        const meta = {
          url,
          launchCommand: "fixture",
          expectedText: "Chat",
          expectedControl: "Type a message",
        };
        const result = await new NoneSandbox(dir).exec(controlProbeCommand(meta), {
          cwd: dir,
          timeoutMs: 15000,
          signal: new AbortController().signal,
          env: { XDG_CACHE_HOME: dir },
        });
        const probe = parseControlProbe(result.stdout);
        expect(probe).not.toBeNull();
        expect(probe!.controlFound).toBe(true);
        expect(probe!.controlVisible).toBe(true);
        expect(probe!.contrastRatio).toBeCloseTo(low ? 1 : 21, 1);
        expect(classifyControlAttempt(probe, result, meta).kind).toBe(low ? "fail" : "pass");
      }
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  },
  40000,
);
