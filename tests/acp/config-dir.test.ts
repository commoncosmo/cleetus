import { expect, test } from "bun:test";
import { parseAcpOptions } from "../../src/acp/cli";

const argv = (...rest: string[]) => ["/bin/bun", "cleetus", "acp", ...rest];

test("parses --config-dir", () => {
  expect(parseAcpOptions(argv("--config-dir", "/app/cfg")).configDir).toBe("/app/cfg");
});
test("config-dir absent → undefined", () => {
  expect(parseAcpOptions(argv("--model", "x")).configDir).toBeUndefined();
});
