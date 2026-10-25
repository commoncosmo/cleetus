import { expect, it } from "bun:test";
import type { ProviderConfig } from "../../src/config/types";
import { providerEnvironmentChecks } from "../../src/setup/provider-environment";

const provider: ProviderConfig = {
  type: "lmstudio",
  baseUrl: "http://user:password@example.test/secret-path",
  apiKey: "private-key",
};
it("reports model availability without making a generation request", async () => {
  expect((await providerEnvironmentChecks([["local", provider]], async () => 2))[0]?.status).toBe(
    "pass",
  );
  expect((await providerEnvironmentChecks([["local", provider]], async () => 0))[0]?.status).toBe(
    "warn",
  );
});
it("redacts raw endpoint errors and credentials", async () => {
  const checks = await providerEnvironmentChecks([["local", provider]], async () => {
    throw new Error(`${provider.baseUrl} ${provider.apiKey}`);
  });
  expect(checks[0]?.status).toBe("warn");
  const text = JSON.stringify(checks);
  for (const secret of ["password", "private-key", "secret-path"])
    expect(text).not.toContain(secret);
});
it("bounds unavailable endpoints with a deadline", async () => {
  const checks = await providerEnvironmentChecks(
    [["local", provider]],
    () => new Promise(() => {}),
    5,
  );
  expect(checks[0]?.status).toBe("warn");
  expect(checks[0]?.detail).toContain("timed out");
});
