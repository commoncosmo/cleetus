import { describe, expect, it } from "bun:test";
import { computeNew, countFixed, fingerprint, toMultiset } from "../../src/diagnostics/diff";
import type { Diagnostic } from "../../src/diagnostics/types";

const d = (over: Partial<Diagnostic>): Diagnostic => ({
  file: "src/a.ts",
  line: 10,
  severity: "error",
  code: "TS2304",
  message: "Cannot find name 'foo'",
  ...over,
});

describe("diagnostics diff", () => {
  it("fingerprint ignores line and col", () => {
    expect(fingerprint(d({ line: 10, col: 3 }))).toBe(fingerprint(d({ line: 99, col: 50 })));
    expect(fingerprint(d({ file: "src/b.ts" }))).not.toBe(fingerprint(d({})));
    expect(fingerprint(d({ message: "other error" }))).not.toBe(fingerprint(d({})));
  });

  it("reports a genuinely new diagnostic", () => {
    const baseline = toMultiset([d({})]);
    const current = [d({}), d({ message: "Cannot find name 'bar'" })];
    const fresh = computeNew(baseline, current);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.message).toBe("Cannot find name 'bar'");
  });

  it("does NOT report a pre-existing diagnostic whose line shifted", () => {
    const baseline = toMultiset([d({ line: 10 })]);
    const current = [d({ line: 14 })]; // same key, new line
    expect(computeNew(baseline, current)).toHaveLength(0);
  });

  it("counts a removed diagnostic as fixed", () => {
    const baseline = toMultiset([d({}), d({ message: "Cannot find name 'bar'" })]);
    const current = [d({})];
    expect(countFixed(baseline, current)).toBe(1);
    expect(computeNew(baseline, current)).toHaveLength(0);
  });

  it("treats a second identical error (count 1 -> 2) as one new", () => {
    const baseline = toMultiset([d({})]);
    const current = [d({ line: 10 }), d({ line: 20 })]; // two of the same key
    expect(computeNew(baseline, current)).toHaveLength(1);
    expect(countFixed(baseline, current)).toBe(0);
  });
});
