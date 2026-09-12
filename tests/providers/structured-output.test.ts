import { describe, expect, it, test } from "bun:test";
import {
  NoResponseFormatMemo,
  isNoResponseFormatError,
  looksLikeTruncatedJson,
  parseToolCallEnvelope,
  toolCallEnvelope,
} from "../../src/providers/structured-output";

describe("toolCallEnvelope", () => {
  it("builds a strict all-required envelope with the tool-name enum", () => {
    const env = toolCallEnvelope(["read_file", "bash"]);
    expect(env).toBeDefined();
    expect(env!.kind).toBe("tool-call");
    expect(env!.name).toBe("tool_call");
    expect(env!.schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string", enum: ["read_file", "bash"] },
        arguments: { type: "object" },
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    });
  });
});

describe("parseToolCallEnvelope", () => {
  it("parses a valid envelope", () => {
    expect(parseToolCallEnvelope('{"name":"bash","arguments":{"command":"ls"}}')).toEqual({
      name: "bash",
      args: { command: "ls" },
    });
  });
  it("rejects non-JSON, wrong shapes, and non-object arguments", () => {
    expect(parseToolCallEnvelope("not json")).toBeNull();
    expect(parseToolCallEnvelope('{"name":123,"arguments":{}}')).toBeNull();
    expect(parseToolCallEnvelope('{"name":"bash","arguments":"ls"}')).toBeNull();
    expect(parseToolCallEnvelope('{"name":"bash"}')).toBeNull();
  });
  it("tolerates surrounding whitespace", () => {
    expect(parseToolCallEnvelope('  {"name":"bash","arguments":{}}\n')).not.toBeNull();
  });
});

describe("isNoResponseFormatError", () => {
  it("matches 4xx errors naming response_format / json_schema / structured output", () => {
    expect(
      isNoResponseFormatError(
        new Error("chat request failed (400) unknown field: response_format"),
      ),
    ).toBe(true);
    expect(
      isNoResponseFormatError(new Error("chat request failed (422) json_schema is not supported")),
    ).toBe(true);
    expect(
      isNoResponseFormatError(
        new Error("chat request failed (400) structured output not available"),
      ),
    ).toBe(true);
  });
  it("rejects 5xx and unrelated 4xx", () => {
    expect(
      isNoResponseFormatError(new Error("chat request failed (500) response_format broke")),
    ).toBe(false);
    expect(isNoResponseFormatError(new Error("chat request failed (400) bad model"))).toBe(false);
    expect(isNoResponseFormatError("not an error")).toBe(false);
  });
});

test("toolCallEnvelope returns undefined for an empty roster", () => {
  expect(toolCallEnvelope([])).toBeUndefined();
});

test("toolCallEnvelope unchanged for a non-empty roster", () => {
  const env = toolCallEnvelope(["bash"]);
  expect(env).toBeDefined();
  expect(
    (env!.schema as { properties: { name: { enum: string[] } } }).properties.name.enum,
  ).toEqual(["bash"]);
});

test("looksLikeTruncatedJson: cut-off object yes; valid JSON no; prose no", () => {
  expect(looksLikeTruncatedJson('{"name":"edit_fi')).toBe(true);
  expect(looksLikeTruncatedJson('  {"a": [1, 2')).toBe(true);
  expect(looksLikeTruncatedJson('{"foo": 1}')).toBe(false);
  expect(looksLikeTruncatedJson("plain prose answer")).toBe(false);
  expect(looksLikeTruncatedJson("")).toBe(false);
});

test("NoResponseFormatMemo has/add per provider name", () => {
  const memo = new NoResponseFormatMemo();
  expect(memo.has("lmstudio")).toBe(false);
  memo.add("lmstudio");
  expect(memo.has("lmstudio")).toBe(true);
  expect(memo.has("ollama")).toBe(false);
});
