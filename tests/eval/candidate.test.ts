import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE, loadCandidates } from "../../src/eval/candidate";

test("BASELINE is the all-undefined inheriting candidate", () => {
  expect(BASELINE).toEqual({ name: "baseline" });
});

test("loads candidate yaml files into Candidate overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-cand-"));
  writeFileSync(
    join(dir, "terse.yaml"),
    "system_prompt: Be terse.\ntools:\n  - read_file\n  - bash\nrouting:\n  mode: speed\n",
  );
  writeFileSync(join(dir, "noop.yaml"), "{}\n");
  const cands = loadCandidates(dir);
  expect(cands.map((c) => c.name).sort()).toEqual(["noop", "terse"]);
  const terse = cands.find((c) => c.name === "terse")!;
  expect(terse.systemPrompt).toBe("Be terse.");
  expect(terse.tools).toEqual(["read_file", "bash"]);
  expect(terse.routing).toEqual({ mode: "speed" });
  const noop = cands.find((c) => c.name === "noop")!;
  expect(noop).toEqual({ name: "noop" });
});

test("returns [] when the candidates dir is absent", () => {
  expect(loadCandidates(join(tmpdir(), "cleetus-no-such-cand"))).toEqual([]);
});

test("parses valid routing.tiers and drops malformed ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-cand-tiers-"));
  writeFileSync(
    join(dir, "good.yaml"),
    "routing:\n  tiers:\n    small: { provider: lmstudio, model: small-m }\n    large: { provider: lmstudio, model: large-m }\n",
  );
  writeFileSync(join(dir, "bad.yaml"), "routing:\n  tiers:\n    small: 42\n");
  const cands = loadCandidates(dir);
  const good = cands.find((c) => c.name === "good")!;
  expect(good.routing).toEqual({
    tiers: {
      small: { provider: "lmstudio", model: "small-m" },
      large: { provider: "lmstudio", model: "large-m" },
    },
  });
  const bad = cands.find((c) => c.name === "bad")!;
  expect(bad).toEqual({ name: "bad" }); // malformed tiers dropped → routing omitted
});
