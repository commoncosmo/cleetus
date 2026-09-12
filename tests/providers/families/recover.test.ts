import { expect, test } from "bun:test";
import { detectFamily } from "../../../src/providers/families/detection";
import { recoverToolCalls, stripToolCallMarkup } from "../../../src/providers/families/recover";
import type { ToolSchema } from "../../../src/providers/types";

const TOOLS: ToolSchema[] = [
  {
    name: "read_file",
    description: "",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, line: { type: "number" }, all: { type: "boolean" } },
    },
  },
];

test("recovers qwen-xml call from content and coerces by schema", () => {
  const content =
    "<tool_call><function=read_file><parameter=path>a.ts</parameter>" +
    "<parameter=line>5</parameter><parameter=all>true</parameter></function></tool_call>";
  const r = recoverToolCalls({ content, reasoning: "", tools: TOOLS });
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]!.name).toBe("read_file");
  expect(r.calls[0]!.args).toEqual({ path: "a.ts", line: 5, all: true });
});

test("blank number arg stays a string rather than coercing to 0", () => {
  const content =
    "<tool_call><function=read_file><parameter=path>a.ts</parameter>" +
    "<parameter=line>  </parameter></function></tool_call>";
  const r = recoverToolCalls({ content, reasoning: "", tools: TOOLS });
  expect(r.calls[0]!.args).toEqual({ path: "a.ts", line: "  " });
});

test("rejects calls whose name is not a registered tool (prose mention is safe)", () => {
  const content = '<tool_call>{"name":"not_a_tool","arguments":{}}</tool_call>';
  expect(recoverToolCalls({ content, reasoning: "", tools: TOOLS }).calls).toEqual([]);
});

test("falls back to scanning reasoning when content has no call", () => {
  const reasoning =
    '<|channel|>commentary to=functions.read_file<|message|>{"path":"a.ts"}<|call|>';
  const r = recoverToolCalls({ content: "", reasoning, tools: TOOLS });
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]!.args).toEqual({ path: "a.ts" });
});

test("returns no calls when no tools provided", () => {
  const content = "<tool_call><function=read_file></function></tool_call>";
  expect(recoverToolCalls({ content, reasoning: "", tools: [] }).calls).toEqual([]);
});

test("stripToolCallMarkup removes blocks, keeps prose", () => {
  const text = 'Let me read it.<tool_call>{"name":"read_file","arguments":{}}</tool_call>';
  expect(stripToolCallMarkup(text)).toBe("Let me read it.");
});

test("stripToolCallMarkup removes a harmony block terminated by <|call|>", () => {
  const text = 'ok<|channel|>commentary to=functions.f<|message|>{"a":1}<|call|>done';
  expect(stripToolCallMarkup(text)).toBe("okdone");
});

test("stripToolCallMarkup removes an UNTERMINATED harmony block (parity with parser)", () => {
  const text = 'note<|channel|>commentary to=functions.f<|message|>{"a":1}';
  expect(stripToolCallMarkup(text)).toBe("note");
});

test("stripToolCallMarkup removes a granite tool_call array", () => {
  const text = 'before<|tool_call|>[{"name":"f","arguments":{}}]';
  expect(stripToolCallMarkup(text)).toBe("before");
});

test("recoverToolCalls salts IDs with idSeed so successive calls don't collide", () => {
  const content =
    "<tool_call><function=read_file><parameter=path>a.ts</parameter></function></tool_call>";
  const a = recoverToolCalls({ content, reasoning: "", tools: TOOLS, idSeed: "7" });
  const b = recoverToolCalls({ content, reasoning: "", tools: TOOLS, idSeed: "8" });
  expect(a.calls[0]!.id).not.toBe(b.calls[0]!.id);
  expect(a.calls[0]!.id).toContain("7");
});

test("recoverToolCalls keeps the legacy ID shape when no idSeed is given", () => {
  const content =
    "<tool_call><function=read_file><parameter=path>a.ts</parameter></function></tool_call>";
  const r = recoverToolCalls({ content, reasoning: "", tools: TOOLS });
  expect(r.calls[0]!.id).toBe("recovered-0-read_file");
});

test("recovers a GLM tool call and coerces a numeric arg per the schema", () => {
  const glm = detectFamily("glm-4.6")!;
  const out = recoverToolCalls({
    content: "<tool_call>scroll <arg_key>lines</arg_key> <arg_value>5</arg_value> </tool_call>",
    reasoning: "",
    tools: [
      {
        name: "scroll",
        description: "",
        parameters: { type: "object", properties: { lines: { type: "integer" } } },
      },
    ],
    family: glm,
  });
  expect(out.calls).toEqual([{ id: "recovered-0-scroll", name: "scroll", args: { lines: 5 } }]);
});

test("drops a GLM call to an unregistered tool", () => {
  const glm = detectFamily("glm-4.6")!;
  const out = recoverToolCalls({
    content: "<tool_call>nope <arg_key>x</arg_key> <arg_value>1</arg_value> </tool_call>",
    reasoning: "",
    tools: [],
    family: glm,
  });
  expect(out.calls).toEqual([]);
});

test("recovers a Cohere action tool call with typed args preserved", () => {
  const cohere = detectFamily("north-mini-code-1.0")!;
  const out = recoverToolCalls({
    content:
      '<|START_ACTION|>[{"tool_call_id":"0","tool_name":"read_file","parameters":{"path":"a.ts","line":5}}]<|END_ACTION|>',
    reasoning: "",
    tools: [
      {
        name: "read_file",
        description: "",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, line: { type: "number" } },
        },
      },
    ],
    family: cohere,
  });
  expect(out.calls).toEqual([
    { id: "recovered-0-read_file", name: "read_file", args: { path: "a.ts", line: 5 } },
  ]);
});

test("drops a Cohere action call to an unregistered tool", () => {
  const cohere = detectFamily("north-mini-code-1.0")!;
  const out = recoverToolCalls({
    content:
      '<|START_ACTION|>[{"tool_call_id":"0","tool_name":"nope","parameters":{}}]<|END_ACTION|>',
    reasoning: "",
    tools: [],
    family: cohere,
  });
  expect(out.calls).toEqual([]);
});

test("stripToolCallMarkup removes a Cohere action block", () => {
  const text =
    'note<|START_ACTION|>[{"tool_call_id":"0","tool_name":"x","parameters":{}}]<|END_ACTION|>done';
  expect(stripToolCallMarkup(text)).toBe("notedone");
});
