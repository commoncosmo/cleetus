import { expect, it } from "bun:test";
import { runDoctor } from "../../../src/ui/cli/doctor";

it("shows doctor-specific help without starting a sandbox", async () => {
  let output = "";
  const code = await runDoctor(["bun", "cleetus", "doctor", "--help"], ".", {
    write: (s) => {
      output += s;
    },
    writeErr: () => {},
  });
  expect(code).toBe(0);
  expect(output).toContain("--quick");
  expect(output).toContain("--json");
  expect(output).toContain("--executor");
});
it("rejects unknown flags with a usage error", async () => {
  let error = "";
  const code = await runDoctor(["bun", "cleetus", "doctor", "--bogus"], ".", {
    write: () => {},
    writeErr: (s) => {
      error += s;
    },
  });
  expect(code).toBe(2);
  expect(error).toContain("unknown option");
});
