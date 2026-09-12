import { describe, expect, it } from "bun:test";
import { parseSlashCommand } from "../../src/slash/parser";

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });
  it("parses bare command", () => {
    expect(parseSlashCommand("/help")).toEqual({ name: "help", args: "" });
  });
  it("parses command with args", () => {
    expect(parseSlashCommand("/allow git status*")).toEqual({ name: "allow", args: "git status*" });
  });
  it("strips leading whitespace", () => {
    expect(parseSlashCommand("   /model qwen")).toEqual({ name: "model", args: "qwen" });
  });
});
