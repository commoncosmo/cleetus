import { describe, expect, test } from "bun:test";
import { resolved } from "../../../src/workflows/provenance";
import { dataSelectStep, selectJsonPointer } from "../../../src/workflows/steps/data-select";

describe("data.select@1", () => {
  test("selects arrays and escaped object keys with JSON Pointer", async () => {
    expect(selectJsonPointer({ "a/b": [{ value: 3 }] }, "/a~1b/0/value")).toEqual({
      found: true,
      value: 3,
    });
    const output = await dataSelectStep.execute(
      resolved({ value: { rows: [1, 2] }, pointer: "/rows/1" }, { untrusted: true }),
      { signal: new AbortController().signal, runId: "run", workspace: "/work" },
    );
    expect(output.value).toBe(2);
    expect(output.provenance.untrusted).toBe(true);
  });

  test("supports explicit defaults and rejects unsafe paths", async () => {
    const output = await dataSelectStep.execute(
      resolved({ value: {}, pointer: "/missing", default: null }),
      { signal: new AbortController().signal, runId: "run", workspace: "/work" },
    );
    expect(output.value).toBeNull();
    expect(() => selectJsonPointer({}, "/__proto__")).toThrow("unsafe");
    expect(() => selectJsonPointer({}, "/bad~2escape")).toThrow("invalid JSON Pointer");
  });
});
