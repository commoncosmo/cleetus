import { describe, expect, it } from "bun:test";
import { EditFileTool } from "../../src/tools/edit-file";
import { ReadFileTool } from "../../src/tools/read-file";
import type { Tool } from "../../src/tools/types";
import { validateToolArgs } from "../../src/tools/validate-args";

const edit = new EditFileTool();
const read = new ReadFileTool();

describe("validateToolArgs", () => {
  it("flags the exact repro: edit_file missing path", () => {
    const err = validateToolArgs(edit, { old_text: "a", new_text: "b" });
    expect(err).toContain("edit_file");
    expect(err).toContain("path");
  });

  it("flags read_file missing path", () => {
    expect(validateToolArgs(read, {})).toContain("path");
  });

  it("returns null for fully valid edit_file args", () => {
    expect(validateToolArgs(edit, { path: "x.ts", old_text: "a", new_text: "b" })).toBeNull();
  });

  it("accepts camelCase aliases for snake_case required fields", () => {
    expect(validateToolArgs(edit, { path: "x.ts", oldText: "a", newText: "b" })).toBeNull();
  });

  it("rejects a required string that is empty", () => {
    expect(validateToolArgs(edit, { path: "", old_text: "a", new_text: "b" })).toContain("path");
  });

  it("rejects a required string that is not a string", () => {
    const err = validateToolArgs(edit, { path: 123, old_text: "a", new_text: "b" });
    expect(err).toContain("path");
  });

  it("rejects non-object args", () => {
    expect(validateToolArgs(edit, null)).toContain("arguments object");
    expect(validateToolArgs(edit, "nope")).toContain("arguments object");
  });

  it("returns null when the schema has no required array", () => {
    const stub = { name: "x", parameters: { type: "object", properties: {} } } as unknown as Tool;
    expect(validateToolArgs(stub, {})).toBeNull();
  });
});
