import { expect, test } from "bun:test";
import { parseAcpOptions } from "../../src/acp/cli";

const argv = (...rest: string[]) => ["/bin/bun", "cleetus", "acp", ...rest];

test("parses --instructions into options", () => {
  expect(parseAcpOptions(argv("--instructions", "/tmp/x.md")).instructions).toBe("/tmp/x.md");
});

test("instructions is undefined when the flag is absent", () => {
  expect(parseAcpOptions(argv("--model", "qwen")).instructions).toBeUndefined();
});
