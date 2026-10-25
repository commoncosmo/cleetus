import { expect, test } from "bun:test";
import { RenderRecoveryGuard } from "../../src/agent/render-recovery";

test("stops ct4's render/background/HTTP workarounds after a fixed prerequisite failure", () => {
  const guard = new RenderRecoveryGuard();
  guard.observe("render_check", {
    ok: false,
    verificationUnavailable: true,
    verificationBlocked: true,
  });
  for (const [tool, command] of [
    ["render_check", "npm run dev"],
    ["bash", "Start-Process npm"],
    ["bash", "Start-Job { npx vite }"],
    ["bash", "npm run dev & VITE_PID=$!"],
    ["bash", "Invoke-WebRequest http://localhost:5173"],
    ["smoke_run", "npm run preview"],
  ])
    expect(guard.blocks(tool!, { command })).toBe(true);
  for (const [tool, command] of [
    ["bash", "npm run build"],
    ["read_file", "src/App.tsx"],
    ["bash", "Get-Command pwsh"],
  ])
    expect(guard.blocks(tool!, { command })).toBe(false);
  expect(guard.result().verificationUnavailable).toBe(true);
  expect(new RenderRecoveryGuard().blocks("render_check", {})).toBe(false);
});
test("does not stop recovery for observed app defects or a cold server", () => {
  const guard = new RenderRecoveryGuard();
  guard.observe("render_check", { ok: false, verificationUnavailable: true });
  guard.observe("render_check", { ok: false, verificationObserved: true });
  expect(guard.blocks("render_check", {})).toBe(false);
});
