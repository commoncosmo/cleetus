import { expect, test } from "bun:test";
import { parseCohere } from "../../../src/providers/families/parsers/cohere";
import { parseGlm } from "../../../src/providers/families/parsers/glm";
import { parseGranite } from "../../../src/providers/families/parsers/granite";
import { parseHarmony } from "../../../src/providers/families/parsers/harmony";
import { parseHermesJson } from "../../../src/providers/families/parsers/hermes-json";
import { parseQwenXml } from "../../../src/providers/families/parsers/qwen-xml";

test("harmony: single commentary tool call", () => {
  const text =
    'before<|channel|>commentary to=functions.read_file <|constrain|>json<|message|>{"path":"a.ts"}<|call|>after';
  const r = parseHarmony(text);
  expect(r?.calls).toEqual([{ name: "read_file", rawArgs: { path: "a.ts" } }]);
  expect(r?.stripped).toBe("beforeafter");
});

test("harmony: multiple calls", () => {
  const text =
    '<|channel|>commentary to=functions.a<|message|>{"x":1}<|call|>' +
    '<|channel|>commentary to=functions.b<|message|>{"y":2}<|call|>';
  expect(parseHarmony(text)?.calls).toEqual([
    { name: "a", rawArgs: { x: 1 } },
    { name: "b", rawArgs: { y: 2 } },
  ]);
});

test("harmony: returns null when absent", () => {
  expect(parseHarmony("just prose")).toBeNull();
});

test("qwen-xml: parses function + parameters as strings", () => {
  const text =
    "<tool_call><function=read_file><parameter=path>src/a.ts</parameter>" +
    "<parameter=line>5</parameter></function></tool_call>";
  const r = parseQwenXml(text);
  expect(r?.calls).toEqual([{ name: "read_file", rawArgs: { path: "src/a.ts", line: "5" } }]);
  expect(r?.stripped).toBe("");
});

test("qwen-xml: returns null on a hermes-shaped tool_call", () => {
  expect(parseQwenXml('<tool_call>{"name":"x","arguments":{}}</tool_call>')).toBeNull();
});

test("hermes-json: parses json body", () => {
  const text = '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>';
  expect(parseHermesJson(text)?.calls).toEqual([{ name: "read_file", rawArgs: { path: "a.ts" } }]);
});

test("hermes-json: returns null on a qwen-shaped tool_call", () => {
  expect(parseHermesJson("<tool_call><function=x></function></tool_call>")).toBeNull();
});

test("granite: parses tool_call array", () => {
  const text = '<|tool_call|>[{"name":"read_file","arguments":{"path":"a.ts"}}]';
  const r = parseGranite(text);
  expect(r?.calls).toEqual([{ name: "read_file", rawArgs: { path: "a.ts" } }]);
  expect(r?.stripped).toBe("");
});

test("granite: returns null when absent", () => {
  expect(parseGranite("no tokens here")).toBeNull();
});

test("qwen-xml: does not fabricate a call from a hermes JSON arg containing <function=>", () => {
  const text = '<tool_call>{"name":"a","arguments":{"code":"<function=x></function>"}}</tool_call>';
  expect(parseQwenXml(text)).toBeNull();
});

test("harmony: many unterminated openers parse quickly and return null", () => {
  const text = "<|channel|>commentary to=functions.a".repeat(20000);
  const start = performance.now();
  expect(parseHarmony(text)).toBeNull();
  expect(performance.now() - start).toBeLessThan(500);
});

test("qwen-xml: many unterminated parameter openers parse quickly", () => {
  const text = `<tool_call><function=f>${"<parameter=k>".repeat(20000)}</function></tool_call>`;
  const start = performance.now();
  // No closing </parameter> tags → no params extracted, but must not hang.
  const r = parseQwenXml(text);
  expect(performance.now() - start).toBeLessThan(500);
  // f has a valid <function=…> wrapper, so a call with empty args is acceptable here;
  // the point of the test is it completes fast.
  expect(r?.calls[0]?.name === "f" || r === null).toBe(true);
});

test("hermes-json: an arg value may contain a literal <tool_call> token", () => {
  const text = '<tool_call>{"name":"a","arguments":{"x":"<tool_call> nested"}}</tool_call>';
  expect(parseHermesJson(text)?.calls).toEqual([
    { name: "a", rawArgs: { x: "<tool_call> nested" } },
  ]);
});

test("harmony: a message body may contain a literal <|channel|> token", () => {
  const text = '<|channel|>commentary to=functions.a<|message|>{"x":"<|channel|>"}<|call|>';
  expect(parseHarmony(text)?.calls).toEqual([{ name: "a", rawArgs: { x: "<|channel|>" } }]);
});

test("qwen-xml: a parameter value may contain a literal <parameter= token", () => {
  const text =
    "<tool_call><function=f><parameter=x>see <parameter=y> here</parameter></function></tool_call>";
  expect(parseQwenXml(text)?.calls).toEqual([
    { name: "f", rawArgs: { x: "see <parameter=y> here" } },
  ]);
});

test("qwen-xml: a <function= token inside a param value does not hijack the function name", () => {
  const text =
    "<tool_call><function=f><parameter=x><function=g> text</parameter></function></tool_call>";
  const r = parseQwenXml(text);
  expect(r?.calls[0]?.name).toBe("f");
  expect(r?.calls[0]?.rawArgs).toEqual({ x: "<function=g> text" });
});

test("glm: single tool call with one arg", () => {
  const text =
    "<tool_call>read_file <arg_key>path</arg_key> <arg_value>src/a.ts</arg_value> </tool_call>";
  const r = parseGlm(text);
  expect(r?.calls).toEqual([{ name: "read_file", rawArgs: { path: "src/a.ts" } }]);
  expect(r?.stripped).toBe("");
});

test("glm: multiple args preserve order and string values", () => {
  const text =
    "<tool_call>get_weather <arg_key>location</arg_key> <arg_value>Beijing</arg_value> " +
    "<arg_key>unit</arg_key> <arg_value>celsius</arg_value> </tool_call>";
  expect(parseGlm(text)?.calls).toEqual([
    { name: "get_weather", rawArgs: { location: "Beijing", unit: "celsius" } },
  ]);
});

test("glm: multiple tool_call blocks", () => {
  const text =
    "<tool_call>a <arg_key>x</arg_key> <arg_value>1</arg_value> </tool_call>" +
    "<tool_call>b <arg_key>y</arg_key> <arg_value>2</arg_value> </tool_call>";
  expect(parseGlm(text)?.calls).toEqual([
    { name: "a", rawArgs: { x: "1" } },
    { name: "b", rawArgs: { y: "2" } },
  ]);
});

test("glm: bare no-arg call is claimed", () => {
  expect(parseGlm("<tool_call>list_dir</tool_call>")?.calls).toEqual([
    { name: "list_dir", rawArgs: {} },
  ]);
});

test("glm: does NOT steal a hermes-json block", () => {
  expect(parseGlm('<tool_call>{"name":"x","arguments":{}}</tool_call>')).toBeNull();
});

test("glm: does NOT steal a qwen <function=> block", () => {
  expect(
    parseGlm(
      "<tool_call><function=read_file><parameter=path>a.ts</parameter></function></tool_call>",
    ),
  ).toBeNull();
});

test("glm: returns null when absent", () => {
  expect(parseGlm("just prose")).toBeNull();
});

test("glm: an <arg_key> with no <arg_value> is malformed → not claimed", () => {
  expect(parseGlm("<tool_call>f <arg_key>x</arg_key></tool_call>")).toBeNull();
});

test("cohere: single action tool call with typed args", () => {
  const text =
    '<|START_ACTION|>[{"tool_call_id":"0","tool_name":"bash","parameters":{"command":"ls -al"}}]<|END_ACTION|>';
  const r = parseCohere(text);
  expect(r?.calls).toEqual([{ name: "bash", rawArgs: { command: "ls -al" } }]);
  expect(r?.stripped).toBe("");
});

test("cohere: multiple tool calls in one action array, typed values preserved", () => {
  const text =
    "<|START_ACTION|>[" +
    '{"tool_call_id":"0","tool_name":"read_file","parameters":{"path":"a.ts","line":5}},' +
    '{"tool_call_id":"1","tool_name":"done","parameters":{}}' +
    "]<|END_ACTION|>";
  expect(parseCohere(text)?.calls).toEqual([
    { name: "read_file", rawArgs: { path: "a.ts", line: 5 } },
    { name: "done", rawArgs: {} },
  ]);
});

test("cohere: returns null for a non-array action body", () => {
  expect(parseCohere("<|START_ACTION|>{}<|END_ACTION|>")).toBeNull();
});

test("cohere: returns null for malformed JSON in the envelope", () => {
  expect(parseCohere("<|START_ACTION|>[not json]<|END_ACTION|>")).toBeNull();
});

test("cohere: returns null when absent", () => {
  expect(parseCohere("just prose")).toBeNull();
});

test("cohere: strips the action block, keeps surrounding prose", () => {
  const text =
    'before<|START_ACTION|>[{"tool_call_id":"0","tool_name":"x","parameters":{}}]<|END_ACTION|>after';
  expect(parseCohere(text)?.stripped).toBe("beforeafter");
});
