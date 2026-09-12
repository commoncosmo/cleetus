import { CleetusError } from "../lib/errors";
import { detectFamily, recoverToolCalls } from "./families";
import { fallbackStopSequences } from "./families/registry";
import { fallbackParams } from "./families/shape";
import { looksLikeTruncatedJson, parseToolCallEnvelope } from "./structured-output";
import type { ChatOptions, ModelInfo, StreamEvent, ToolCall, ToolSchema } from "./types";
import { toOpenAIMessage } from "./wire";

export interface OpenAICompatOpts {
  baseUrl: string;
  apiKey?: string;
  /** Some OpenAI-compatible servers prefix their paths differently. */
  pathPrefix?: string; // default "/v1"
  /** llama.cpp accepts the schema directly under response_format.schema rather than the
   *  nested OpenAI json_schema envelope. Its broadly compatible constrained-output form
   *  uses type json_object. */
  responseFormatStyle?: "openai" | "llama.cpp";
}

/** Monotonic salt for recovered tool-call IDs so successive recoveries never collide across
 *  model calls within a session. Process-local; uniqueness only needs to hold within a run. */
let recoverSeq = 0;

function headers(opts: OpenAICompatOpts): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) h.authorization = `Bearer ${opts.apiKey}`;
  return h;
}

function path(opts: OpenAICompatOpts, p: string): string {
  return `${opts.baseUrl}${opts.pathPrefix ?? "/v1"}${p}`;
}

/**
 * Turn a non-OK response into a human-readable message. OpenAI-compatible servers
 * return `{ "error": { "message": "..." } }` (or sometimes a bare string); we surface
 * just that message and never leak the raw JSON envelope. Falls back to whitespace-
 * collapsed body text, then to the bare status code.
 */
async function describeError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      const json = JSON.parse(text);
      const err = json?.error;
      const msg =
        (typeof err === "object" && err && typeof err.message === "string" && err.message) ||
        (typeof err === "string" && err) ||
        (typeof json?.message === "string" && json.message);
      if (msg) return `(${res.status}) ${String(msg).replace(/\s+/g, " ").trim()}`;
    } catch {
      // not JSON — fall through to plain text
    }
    return `(${res.status}) ${text.replace(/\s+/g, " ").trim().slice(0, 300)}`;
  }
  return `HTTP ${res.status}`;
}

export async function listModelsOpenAI(opts: OpenAICompatOpts): Promise<ModelInfo[]> {
  let res: Response;
  try {
    res = await fetch(path(opts, "/models"), { headers: headers(opts) });
  } catch (e) {
    throw new CleetusError(
      "PROVIDER_UNREACHABLE",
      `cannot reach ${opts.baseUrl}: ${(e as Error).message}`,
      { cause: e },
    );
  }
  if (!res.ok) {
    throw new CleetusError(
      "PROVIDER_UNREACHABLE",
      `models request failed ${await describeError(res)}`,
    );
  }
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  if (!Array.isArray(json.data))
    throw new CleetusError("PROVIDER_INVALID_RESPONSE", "missing data array");
  return json.data.map((m) => ({ id: m.id }));
}

function toOpenAITool(t: ToolSchema): unknown {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

function responseFormat(opts: OpenAICompatOpts, req: ChatOptions): unknown {
  if (!req.responseFormat) return undefined;
  if (opts.responseFormatStyle === "llama.cpp") {
    return { type: "json_object", schema: req.responseFormat.schema };
  }
  return {
    type: "json_schema",
    json_schema: {
      name: req.responseFormat.name,
      strict: true,
      schema: req.responseFormat.schema,
    },
  };
}

export async function* chatOpenAI(
  opts: OpenAICompatOpts,
  req: ChatOptions,
): AsyncIterable<StreamEvent> {
  const familyEnabled = req.modelFamily?.enabled ?? true;
  const family = familyEnabled ? detectFamily(req.model, req.modelFamily?.override) : null;
  // Enabled-but-unmatched: an unrecognized local model (renamed/merged GGUF) gets a
  // conservative default profile instead of nothing — see fallbackParams/fallbackStopSequences.
  const unknownFamily = familyEnabled && family === null;
  const sampling = family?.defaultParams() ?? (unknownFamily ? fallbackParams() : {});
  const body = {
    model: req.model,
    messages: family
      ? family.buildMessages(req.messages)
      : req.messages.map((m) => toOpenAIMessage(m)),
    stream: true,
    // Without this, OpenAI-compatible servers (LM Studio, Ollama) omit usage
    // entirely from streamed responses, so the status-bar token counters stay 0.
    stream_options: { include_usage: true },
    temperature: req.temperature ?? sampling.temperature,
    top_p: req.topP ?? sampling.topP,
    top_k: req.topK ?? sampling.topK,
    presence_penalty: req.presencePenalty ?? sampling.presencePenalty,
    max_tokens: req.maxOutputTokens,
    // Family-supplied stop sequences (GLM's <|observation|> must halt generation). undefined →
    // dropped by JSON.stringify, so families without stop sequences are unaffected.
    stop: family?.stopSequences ?? (unknownFamily ? fallbackStopSequences() : undefined),
    // undefined → dropped by JSON.stringify, preserving prior behavior for callers that don't set it.
    reasoning_effort: req.reasoningEffort,
    // Constrained decoding (WS4). undefined → dropped by JSON.stringify, like `stop`.
    response_format: responseFormat(opts, req),
    // llama.cpp thinking templates can bypass grammar enforcement. Disable thinking only for
    // constrained output; ordinary chats retain the model/server's configured reasoning mode.
    chat_template_kwargs:
      opts.responseFormatStyle === "llama.cpp" && req.responseFormat
        ? { enable_thinking: false }
        : undefined,
    tools: req.tools?.length ? req.tools.map(toOpenAITool) : undefined,
  };
  let res: Response;
  try {
    res = await fetch(path(opts, "/chat/completions"), {
      method: "POST",
      headers: headers(opts),
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (e) {
    throw new CleetusError("PROVIDER_UNREACHABLE", `chat failed: ${(e as Error).message}`, {
      cause: e,
    });
  }
  if (!res.ok || !res.body) {
    // A 5xx means the server failed while generating (e.g. the model emitted an
    // invalid tool call the server couldn't parse) — no tool has run, so a single
    // resample is safe. 4xx (bad request) is a caller fault and not retryable.
    const retryable = res.status >= 500;
    throw new CleetusError(
      "PROVIDER_INVALID_RESPONSE",
      `chat request failed ${await describeError(res)}`,
      { retryable },
    );
  }
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  const partialToolCalls: Map<
    number,
    { id: string; name: string; argsBuf: string; argsObject?: Record<string, unknown> }
  > = new Map();
  let finishReason: "stop" | "tool-calls" | "length" | "error" = "stop";
  let usage: { input?: number; output?: number } | undefined;
  let servedModel: string | undefined;
  let contentBuf = "";
  let reasoningBuf = "";

  try {
    while (true) {
      const { value, done } = await reader.read().catch((error: unknown) => {
        if (req.signal?.aborted) throw error;
        // Tool calls remain buffered until the stream completes, so a failed read
        // can use the runtime's single retry without executing partial calls twice.
        throw new CleetusError(
          "PROVIDER_UNREACHABLE",
          `chat stream interrupted: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error, retryable: true },
        );
      });
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        // biome-ignore lint/suspicious/noExplicitAny: dynamic SSE payload
        let payload: any;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        // Usage can ride on any chunk (often the final empty-choices one); capture it
        // whenever it appears, then continue processing any choice in the same chunk.
        if (payload.usage) {
          usage = {
            input: payload.usage.prompt_tokens,
            output: payload.usage.completion_tokens,
          };
        }
        if (typeof payload.model === "string" && payload.model.length > 0) {
          servedModel = payload.model;
        }
        const choice = payload.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          contentBuf += delta.content;
          // kind "tool-call": the content is machine JSON for envelope synthesis — never
          // stream it as prose. Buffered above unconditionally; flushed late (below) only
          // if synthesis fails. kind "json" (or absent) streams normally.
          const suppressDeltas = req.responseFormat?.kind === "tool-call";
          if (!suppressDeltas) yield { type: "text-delta", text: delta.content };
        }
        const reasoning =
          typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string"
              ? delta.reasoning
              : "";
        if (reasoning.length > 0) {
          reasoningBuf += reasoning;
          yield { type: "reasoning-delta", text: reasoning };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let partial = partialToolCalls.get(idx);
            if (!partial) {
              partial = { id: tc.id ?? `tc-${idx}`, name: tc.function?.name ?? "", argsBuf: "" };
              partialToolCalls.set(idx, partial);
            }
            if (tc.id) partial.id = tc.id;
            if (tc.function?.name) partial.name = tc.function.name;
            const toolArgs = tc.function?.arguments;
            if (typeof toolArgs === "string" && toolArgs.length > 0) {
              partial.argsBuf += toolArgs;
              yield { type: "tool-call-delta", index: idx };
            } else if (toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)) {
              partial.argsObject = toolArgs as Record<string, unknown>;
              yield { type: "tool-call-delta", index: idx };
            }
          }
        }
        if (choice.finish_reason) {
          finishReason =
            choice.finish_reason === "tool_calls"
              ? "tool-calls"
              : choice.finish_reason === "length"
                ? "length"
                : "stop";
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const sortedIndices = [...partialToolCalls.keys()].sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    const partial = partialToolCalls.get(idx)!;
    let args: unknown = partial.argsObject ?? {};
    if (!partial.argsObject) {
      try {
        args = partial.argsBuf ? JSON.parse(partial.argsBuf) : {};
      } catch {
        /* leave as {} */
      }
    }
    const call: ToolCall = { id: partial.id, name: partial.name, args };
    yield { type: "tool-call", call };
  }

  // Constrained-retry synthesis (WS4): a kind:"tool-call" request's content is the envelope.
  // On success, synthesize the call (same contract as regex recovery). On failure, flush the
  // suppressed content as one late text-delta so a legit prose answer from a server that
  // ignored response_format is never lost, then fall through to the family-recovery ladder.
  let envelopeConsumed = false;
  if (req.responseFormat?.kind === "tool-call" && partialToolCalls.size === 0) {
    const env = parseToolCallEnvelope(contentBuf);
    if (env) {
      yield {
        type: "tool-call",
        call: { id: `sof-${recoverSeq++}`, name: env.name, args: env.args },
        recovered: true,
      };
      envelopeConsumed = true;
      if (finishReason === "stop") finishReason = "tool-calls";
    } else if (contentBuf.length > 0 && !looksLikeTruncatedJson(contentBuf)) {
      yield { type: "text-delta", text: contentBuf };
    }
  }

  if (partialToolCalls.size === 0 && familyEnabled && !envelopeConsumed) {
    const recovered = recoverToolCalls({
      content: contentBuf,
      reasoning: reasoningBuf,
      tools: req.tools,
      family,
      idSeed: String(recoverSeq++),
    });
    if (recovered.calls.length > 0) {
      for (const call of recovered.calls) {
        yield { type: "tool-call", call, recovered: true };
      }
      // Only promote a clean stop; never overwrite a "length" truncation (preserves the
      // downstream truncation notice and avoids dispatching a call from an incomplete response)
      // or an "error" finish.
      if (finishReason === "stop") finishReason = "tool-calls";
    }
  }

  yield { type: "finish", reason: finishReason, usage, model: servedModel };
}

export async function embedOpenAI(
  opts: OpenAICompatOpts,
  text: string,
  model?: string,
): Promise<number[]> {
  const body = { input: text, model: model ?? "text-embedding" };
  let res: Response;
  try {
    res = await fetch(path(opts, "/embeddings"), {
      method: "POST",
      headers: headers(opts),
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new CleetusError("PROVIDER_UNREACHABLE", `embed failed: ${(e as Error).message}`, {
      cause: e,
    });
  }
  if (!res.ok)
    throw new CleetusError(
      "PROVIDER_INVALID_RESPONSE",
      `embed request failed ${await describeError(res)}`,
    );
  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new CleetusError("PROVIDER_INVALID_RESPONSE", "missing embedding");
  return vec;
}
