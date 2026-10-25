import { expect, it } from "bun:test";
import { createSandboxWithInfo, sandboxStatus } from "../../src/sandbox/factory";
import { WindowsSandbox, windowsQuote } from "../../src/sandbox/windows";

it("quotes Windows argv without losing embedded quotes or trailing slashes", () => {
  expect(windowsQuote("hello world")).toBe('"hello world"');
  expect(windowsQuote('a"b')).toBe('"a\\"b"');
  expect(windowsQuote("C:\\space dir\\")).toBe('"C:\\space dir\\\\"');
});
it("selects MXC only after Windows preflight passes", async () => {
  const selection = await createSandboxWithInfo({ backend: "host", network: false }, ".", {
    platform: "win32",
    hasBwrap: () => false,
    env: {},
    preflightWindows: async () => null,
  });
  expect(selection.sandbox).toBeInstanceOf(WindowsSandbox);
  expect(selection.backend).toBe("mxc");
  expect(sandboxStatus(selection.backend, false)).toBe("Sandbox: MXC");
});
it("fails closed when a requested Windows sandbox is unavailable", async () => {
  await expect(
    createSandboxWithInfo({ backend: "host", network: true }, ".", {
      platform: "win32",
      hasBwrap: () => false,
      env: {},
      preflightWindows: async () => "missing executor",
    }),
  ).rejects.toThrow("Windows sandbox unavailable: missing executor");
});
