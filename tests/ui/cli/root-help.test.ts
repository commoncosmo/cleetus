import { describe, expect, test } from "bun:test";
import { ROOT_COMMAND_HELP } from "../../../src/ui/cli/root-help";

describe("cleetus root help", () => {
  test("advertises every standalone command dispatched by the root binary", () => {
    expect(ROOT_COMMAND_HELP).toContain("workflow [command]");
    expect(ROOT_COMMAND_HELP).toContain("initialize");
    expect(ROOT_COMMAND_HELP).toContain("analyze");
    expect(ROOT_COMMAND_HELP).toContain("eval");
    expect(ROOT_COMMAND_HELP).toContain("improve");
    expect(ROOT_COMMAND_HELP).toContain("acp");
    expect(ROOT_COMMAND_HELP).toContain("cleetus <command> --help");
  });
});
