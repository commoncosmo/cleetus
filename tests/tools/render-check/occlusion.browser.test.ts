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

test.skipIf(process.env.CLEETUS_BROWSER_SMOKE !== "1")(
  "real browser accepts rounded controls while rejecting center and edge overlays",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "occlusion-browser-"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const shape = new URL(request.url).pathname.slice(1);
        const size = shape === "circle" ? "60px;height:60px" : "142px;height:49px";
        const overlay =
          shape === "center" || shape === "edge"
            ? `<div id="blocker" style="position:absolute;left:${shape === "center" ? 166 : 100}px;top:118px;width:12px;height:14px;background:red"></div>`
            : "";
        return new Response(
          `<html><body><h1>Controls</h1><button style="position:absolute;left:100px;top:100px;width:${size};border-radius:${shape === "square" ? "0" : "999px"};background:navy;color:white" onclick="document.querySelector('#result').textContent='Clicked'"><span>Go</span></button>${overlay}<p id="result"></p></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    try {
      for (const shape of ["pill", "circle", "square", "center", "edge"]) {
        const meta = {
          url: `http://127.0.0.1:${server.port}/${shape}`,
          launchCommand: "fixture",
          expectedText: "Controls",
          expectedControl: "Go",
          expectedAfterText: "Clicked",
        };
        const result = await new NoneSandbox(dir).exec(controlProbeCommand(meta), {
          cwd: dir,
          timeoutMs: 15000,
          signal: new AbortController().signal,
          env: { XDG_CACHE_HOME: dir },
        });
        const probe = parseControlProbe(result.stdout);
        const blocked = shape === "center" || shape === "edge";
        expect(probe).not.toBeNull();
        expect(probe!.controlVisible).toBe(true);
        expect(probe!.controlOccluded).toBe(blocked);
        expect(probe!.afterTextPresent).toBe(blocked ? undefined : true);
        expect(classifyControlAttempt(probe, result, meta).kind).toBe(blocked ? "fail" : "pass");
        if (blocked) expect(probe!.detail).toContain("#blocker");
      }
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
