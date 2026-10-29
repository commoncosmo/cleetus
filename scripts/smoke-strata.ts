import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { AgentRuntime } from "../src/agent/runtime";
import { staticRouter } from "../src/agent/router";
import { EventLog } from "../src/events/log";
import { ModelContextCache } from "../src/providers/model-context-cache";
import { ProviderRegistry } from "../src/providers/registry";
import { StrataProvider } from "../src/providers/strata";
import type { ChatOptions, Provider, StreamEvent } from "../src/providers/types";
import { ToolDispatcher } from "../src/tools/dispatcher";
import { ToolRegistry } from "../src/tools/registry";

// Synthetic inference only; no real filesystem/shell tools or user configuration.
const baseUrl = (process.argv[2] ?? process.env.STRATA_BASE_URL ?? "http://localhost:47832")
  .replace(/\/v1\/?$/, "")
  .replace(/\/$/, "");
const apiKey = process.env.STRATA_API_KEY;
const provider = new StrataProvider({ baseUrl, apiKey });
const models = await provider.listModels();
const model = process.env.STRATA_MODEL ?? models[0]?.id;
assert(model, "No Strata model available");
console.log("MODEL", model);

async function collect(options: Partial<ChatOptions>) {
  const events: StreamEvent[] = [];
  for await (const event of provider.chat({
    model,
    messages: [{ role: "user", content: "Reply OK only." }],
    reasoningEffort: "low",
    maxOutputTokens: 1024,
    signal: AbortSignal.timeout(60000),
    ...options,
  }))
    events.push(event);
  return events;
}
const native = await provider.probeModelContextInfo(model);
console.log(
  "CONTEXT",
  JSON.stringify({ info: native ?? null, warnings: await provider.readinessWarnings(model) }),
);
const fallbackWindow = Number(process.env.STRATA_CONTEXT_LENGTH ?? 4096);
assert(Number.isInteger(fallbackWindow) && fallbackWindow > 0);
const fallbackProvider = new StrataProvider({ baseUrl, apiKey, contextLength: fallbackWindow });
const registry = new ProviderRegistry();
registry.register("strata", fallbackProvider);
const cache = new ModelContextCache(registry);
await cache.prime([{ provider: "strata", model }]);
const info = cache.getInfo("strata", model);
assert.deepEqual(info, native ?? { window: fallbackWindow, source: "configured" });
console.log("CONTEXT_CACHE_PASS", JSON.stringify(info));

const tool = {
  name: "glob",
  description: "Synthetic test tool. Returns strata-ok; does not inspect files.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
const messages: ChatOptions["messages"] = [
  {
    role: "system",
    content: "You are testing tool protocol compatibility. Use the requested tool exactly once.",
  },
  { role: "user", content: "Call glob now. After its result, reply with the value it returns." },
];
const events = await collect({ messages, tools: [tool] });
const call = events.find((event) => event.type === "tool-call");
assert(call?.type === "tool-call" && call.call.name === "glob", "Native tool call missing");
assert(events.some((event) => event.type === "finish" && event.usage?.input));
const followup = await collect({
  messages: [
    ...messages,
    { role: "assistant", content: "", toolCalls: [call.call] },
    { role: "tool", content: "strata-ok", toolCallId: call.call.id },
  ],
  tools: [tool],
});
assert(
  followup
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("")
    .includes("strata-ok"),
);
console.log("NATIVE_TOOL_ROUNDTRIP_PASS");

const schemaEvents = await collect({
  messages: [{ role: "user", content: "Reply with the plain text BANANA, without JSON." }],
  tools: [tool],
  responseFormat: {
    kind: "json",
    name: "probe",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean", const: true } },
      required: ["ok"],
      additionalProperties: false,
    },
  },
});
const schemaText = schemaEvents
  .filter((event) => event.type === "text-delta")
  .map((event) => event.text)
  .join("");
assert.deepEqual(JSON.parse(schemaText), { ok: true });
console.log("JSON_SCHEMA_WITH_TOOLS_PASS");

// Force the real runtime's corrective recovery branch once; only the fault is
// injected. The constrained retry, synthesized call and subsequent answer use Strata.
let injected = false,
  constrained = false,
  runs = 0;
const faultProvider: Provider = {
  listModels: () => provider.listModels(),
  embed: (...args) => provider.embed(...args),
  async *chat(req) {
    if (!injected) {
      injected = true;
      yield {
        type: "reasoning-delta",
        text: 'I will call <tool_call>{"name":"glob","arguments":{}}</tool_call> now',
      };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (req.responseFormat?.kind === "tool-call") constrained = true;
    yield* provider.chat({ ...req, reasoningEffort: "low", maxOutputTokens: 1024 });
  },
};
const scratchRoot = resolve("dist/strata-smoke");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "run-"));
const log = new EventLog(join(scratch, "events.db"));
const runtimeProviders = new ProviderRegistry();
runtimeProviders.register("strata", faultProvider);
const tools = new ToolRegistry();
tools.register({
  ...tool,
  mutates: false,
  serialize: () => "synthetic glob",
  run: async () => {
    runs++;
    return { ok: true, output: "strata-ok" };
  },
});
try {
  const runtime = new AgentRuntime({
    providers: runtimeProviders,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "strata", model }),
    systemPrompt: () =>
      "You are a protocol tester. Call glob once to obtain the test value, then report it. Do not call any tool after receiving strata-ok.",
    projectDir: scratch,
    resolvePermission: async () => "allow",
    maxToolLoops: 4,
    modelContextInfo: () => info,
    capability: () => "standard",
  });
  await runtime.runTurn(
    "strata-recovery",
    "Call glob once and report its returned value. This is a synthetic protocol test, not a project task.",
    AbortSignal.timeout(60000),
  );
  assert(constrained, "Runtime did not enter structured-output recovery");
  assert.equal(runs, 1, "Recovered tool must dispatch exactly once");
  const transcript = runtime.getMessages("strata-recovery");
  assert(
    transcript.some(
      (message) => message.role === "assistant" && message.content.includes("strata-ok"),
    ),
    "Final answer missing test value",
  );
  console.log("RUNTIME_STRUCTURED_RECOVERY_PASS", scratch);
} finally {
  log.close();
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("strata smoke cancellation")), 800);
try {
  await assert.rejects(
    collect({
      messages: [
        { role: "user", content: "Count from one to one thousand, spelling every number." },
      ],
      signal: controller.signal,
    }),
    /strata smoke cancellation/,
  );
} finally {
  clearTimeout(timer);
}
const afterCancel = await collect({});
assert(afterCancel.some((event) => event.type === "text-delta"));
console.log("CANCELLATION_AND_NEXT_REQUEST_PASS");
console.log("STRATA_SMOKE_PASS");
