import type { ModelFamilyName } from "./families/types";
import type { VisionSupport } from "./vision";

export interface ModelInfo {
  id: string;
  contextLength?: number;
}

/** Provider metadata occasionally uses 0/NaN as an "unknown" sentinel. Treat only finite,
 * positive windows as usable so a bad discovery response cannot collapse history budgeting. */
export function usableContextLength(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export type WindowSource = "loaded" | "architectural";
export interface WindowInfo {
  window: number;
  source: WindowSource;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ImageRef {
  mime: string;
  path: string;
  sha256: string;
}

export interface Message {
  /** Internal history marker: runtime reminders must not replace the originating request. */
  turnOrigin?: boolean;
  /** Verbatim user input; null identifies a host-generated workflow turn. */
  userRequest?: string | null;
  role: Role;
  content: string;
  images?: ImageRef[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Assistant chain-of-thought retained for gpt-oss CoT pass-through (facet #4). */
  reasoning?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: object; // JSON schema
}

export interface ChatOptions {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  /** Maximum generated tokens, including reasoning tokens on providers that bill them as output.
   * Omitted for normal agent calls; bounded corrective/finalization passes use it to prevent a
   * copy edit from becoming another open-ended reasoning run. */
  maxOutputTokens?: number;
  /** Family-adapter settings threaded from config; undefined → treated as enabled. */
  modelFamily?: { enabled?: boolean; override?: ModelFamilyName };
  /** Reasoning-effort dial → OpenAI `reasoning_effort`. Omitted from the body when undefined. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Constrained decoding: when present, the request carries OpenAI-compat
   *  `response_format: {type: "json_schema"}` so the completion must satisfy `schema`.
   *  kind "tool-call": the content is the tool-call envelope — the provider synthesizes a
   *  tool-call event from it and suppresses live text deltas. kind "json": the caller owns
   *  parsing (deltas stream normally). */
  responseFormat?: { name: string; schema: object; kind: "tool-call" | "json" };
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; index: number }
  | { type: "tool-call"; call: ToolCall; recovered?: boolean }
  | {
      type: "finish";
      reason: "stop" | "tool-calls" | "length" | "error";
      usage?: { input?: number; output?: number };
      /** The model the server actually served (from the response `model` field), if reported. */
      model?: string;
    };

export interface Provider {
  listModels(): Promise<ModelInfo[]>;
  chat(opts: ChatOptions): AsyncIterable<StreamEvent>;
  embed(text: string, model?: string): Promise<number[]>;
  /** Best-effort single-model context window from provider metadata (Ollama /api/show),
   *  used when listModels() reports no window for the active model. Undefined = unknown.
   *  Optional: providers without model metadata omit it. */
  probeModelContext?(model: string): Promise<number | undefined>;
  /** Provider-native context evidence when the endpoint can distinguish the active served window
   *  from an architectural ceiling. Preferred over probeModelContext when present. */
  probeModelContextInfo?(model: string): Promise<WindowInfo | undefined>;
  /** Best-effort provider-specific readiness checks for the selected model. Empty means no
   *  known issue; providers must not fail startup when an advisory endpoint is unavailable. */
  readinessWarnings?(model: string): Promise<string[]>;
  /** Best-effort vision-capability verdict for a model; omitted providers are treated as unknown. */
  supportsVision?(model: string): Promise<VisionSupport>;
}
