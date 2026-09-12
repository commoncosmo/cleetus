import { type ModelInfo, usableContextLength } from "./types";
import { type VisionSupport, parseOllamaVision } from "./vision";

interface LMStudioModelRow {
  id: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}

interface OllamaPsRow {
  name?: string;
  model?: string;
  context_length?: number;
}

interface LlamaCppProps {
  default_generation_settings?: { n_ctx?: unknown };
  chat_template_caps?: unknown;
}

/** Below this many tokens, warn the user their model's loaded window is small. */
export const LOW_CONTEXT_THRESHOLD = 16384;

/** Map LM Studio's /api/v0/models payload to ModelInfo with the served window. Prefers the
 *  loaded window, falls back to the model's max, omits when neither is numeric. Pure. */
export function parseLMStudioModels(json: unknown): ModelInfo[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelInfo[] = [];
  for (const row of data) {
    if (!row || typeof (row as { id?: unknown }).id !== "string") continue;
    const r = row as LMStudioModelRow;
    const reported =
      typeof r.loaded_context_length === "number"
        ? r.loaded_context_length
        : typeof r.max_context_length === "number"
          ? r.max_context_length
          : undefined;
    const ctx = usableContextLength(reported);
    out.push(ctx !== undefined ? { id: r.id, contextLength: ctx } : { id: r.id });
  }
  return out;
}

/** Map Ollama's /api/ps payload to id → effective context length for loaded models that
 *  report it. Keys on both `name` and `model` so either id form matches listModels. Pure. */
export function parseOllamaPs(json: unknown): Map<string, number> {
  const map = new Map<string, number>();
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return map;
  for (const row of models) {
    if (!row) continue;
    const r = row as OllamaPsRow;
    const contextLength = usableContextLength(r.context_length);
    if (contextLength === undefined) continue;
    if (typeof r.name === "string") map.set(r.name, contextLength);
    if (typeof r.model === "string") map.set(r.model, contextLength);
  }
  return map;
}

/** A one-line warning when a known loaded window is below the threshold, else null. Pure. */
export function lowContextWarning(
  model: string,
  contextLength: number | undefined,
  threshold: number = LOW_CONTEXT_THRESHOLD,
  providerType?: string,
): string | null {
  const usable = usableContextLength(contextLength);
  if (usable === undefined || usable >= threshold) return null;
  const guidance =
    providerType === "llama.cpp"
      ? "llama.cpp: --ctx-size / LLAMA_ARG_CTX_SIZE"
      : "LM Studio: Context Length; Ollama: num_ctx / OLLAMA_CONTEXT_LENGTH";
  return `${model} is loaded with only ${usable} tokens of context — raise it (${guidance}) for longer agentic sessions.`;
}

interface NativeOpts {
  baseUrl: string;
  apiKey?: string;
}

function authHeaders(opts: NativeOpts): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) h.authorization = `Bearer ${opts.apiKey}`;
  return h;
}

function llamaCppPropsUrl(opts: NativeOpts, model: string): string {
  const url = new URL(`${opts.baseUrl}/props`);
  url.searchParams.set("model", model);
  return url.toString();
}

/** Extract llama.cpp's effective served context. Unlike /v1/models meta.n_ctx_train, this is
 *  the actual per-slot n_ctx selected by --ctx-size. */
export function parseLlamaCppContext(json: unknown): number | undefined {
  const props = json as LlamaCppProps | null;
  return usableContextLength(props?.default_generation_settings?.n_ctx);
}

/** Convert explicit llama.cpp chat-template capability failures into actionable advisories.
 *  Missing/older capability metadata is treated as unknown rather than a failure. */
export function llamaCppReadinessWarnings(json: unknown): string[] {
  const caps = (json as LlamaCppProps | null)?.chat_template_caps;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return [];
  const c = caps as Record<string, unknown>;
  const warnings: string[] = [];
  if (c.supports_tools === false || c.supports_tool_calls === false) {
    warnings.push(
      "llama.cpp reports that this chat template does not support tool calls; restart llama-server with --jinja and a tool-capable model template (or an explicit --chat-template-file)",
    );
  }
  if (c.supports_system_role === false) {
    warnings.push(
      "llama.cpp reports that this chat template does not support system messages; choose a compatible template so Cleetus instructions are preserved",
    );
  }
  return warnings;
}

/** Fetch llama.cpp's read-only /props metadata for a specific model. Router mode uses the model
 *  query parameter; single-model servers accept the same endpoint. */
export async function fetchLlamaCppProps(opts: NativeOpts, model: string): Promise<unknown> {
  const res = await fetch(llamaCppPropsUrl(opts, model), { headers: authHeaders(opts) });
  if (!res.ok) throw new Error(`/props ${res.status}`);
  return res.json();
}

/** Fetch + parse LM Studio's native model list. Throws on unreachable/non-OK so the caller
 *  can fall back to the OpenAI id-only list. */
export async function fetchLMStudioModels(opts: NativeOpts): Promise<ModelInfo[]> {
  const res = await fetch(`${opts.baseUrl}/api/v0/models`, { headers: authHeaders(opts) });
  if (!res.ok) throw new Error(`/api/v0/models ${res.status}`);
  return parseLMStudioModels(await res.json());
}

/** Fetch + parse Ollama's loaded-model context lengths. Best-effort: returns an empty map on
 *  any failure (caller keeps the OpenAI id-only list). */
export async function fetchOllamaContextLengths(opts: NativeOpts): Promise<Map<string, number>> {
  try {
    const res = await fetch(`${opts.baseUrl}/api/ps`, { headers: authHeaders(opts) });
    if (!res.ok) return new Map();
    return parseOllamaPs(await res.json());
  } catch {
    return new Map();
  }
}

/** Extract the architecture context window from an Ollama /api/show payload: the single
 *  `model_info` key ending in `.context_length` (e.g. `glm5.2.context_length`,
 *  `llama.context_length`). Undefined when absent or non-numeric. Pure. */
export function parseOllamaShow(json: unknown): number | undefined {
  const mi = (json as { model_info?: unknown } | null)?.model_info;
  if (!mi || typeof mi !== "object") return undefined;
  for (const [k, v] of Object.entries(mi as Record<string, unknown>)) {
    if (!k.endsWith(".context_length")) continue;
    const contextLength = usableContextLength(v);
    if (contextLength !== undefined) return contextLength;
  }
  return undefined;
}

/** Fetch one model's architecture context window from Ollama's /api/show, keyed on the
 *  REQUESTED name (sidesteps the served-name mismatch, and works for cloud models that never
 *  appear in /api/ps). Best-effort: undefined on any non-OK/throw. */
export async function fetchOllamaModelContext(
  opts: NativeOpts,
  model: string,
): Promise<number | undefined> {
  try {
    const res = await fetch(`${opts.baseUrl}/api/show`, {
      method: "POST",
      headers: authHeaders(opts),
      body: JSON.stringify({ name: model }),
    });
    if (!res.ok) return undefined;
    return parseOllamaShow(await res.json());
  } catch {
    return undefined;
  }
}

/** Fetch one model's vision-capability verdict from Ollama's /api/show. Best-effort:
 *  "unknown" on any non-OK/throw so callers can fall back to a soft warning. */
export async function fetchOllamaVision(opts: NativeOpts, model: string): Promise<VisionSupport> {
  try {
    const res = await fetch(`${opts.baseUrl}/api/show`, {
      method: "POST",
      headers: authHeaders(opts),
      body: JSON.stringify({ name: model }),
    });
    if (!res.ok) return "unknown";
    return parseOllamaVision(await res.json());
  } catch {
    return "unknown";
  }
}
