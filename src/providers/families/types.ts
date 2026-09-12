import type { EffortLevel } from "../../agent/effort";
import type { Message } from "../types";

export type ModelFamilyName = "gpt-oss" | "qwen" | "gemma" | "granite" | "glm" | "cohere" | "muse";
export type ToolFormat = "harmony" | "qwen-xml" | "hermes-json" | "granite" | "glm" | "cohere";

/** A tool call as parsed from raw text — args may be string-typed (XML) or already typed (JSON). */
export interface RawCall {
  name: string;
  rawArgs: Record<string, unknown>;
}

export interface ParseResult {
  calls: RawCall[];
  /** `text` with this format's markup blocks removed. */
  stripped: string;
}

export interface SamplingDefaults {
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
}

export interface FamilyAdapter {
  name: ModelFamilyName;
  /** True when this family owns the given model id (substring match). */
  matches(modelId: string): boolean;
  /** Recommended sampling, applied only to caller-undefined fields (facet #3). */
  defaultParams(): SamplingDefaults;
  /** Build wire messages — folds system (Gemma) / includes reasoning (gpt-oss). Facets #2/#4. */
  buildMessages(messages: Message[]): unknown[];
  /** Recovery parser tried first before sniffing the rest (facet #1). */
  preferredFormat: ToolFormat;
  /** Whether the family's models accept a reasoning/thinking request. `undefined`/`true` → yes
   *  (default); `false` → the caller must NOT send `reasoning_effort` (e.g. granite on Ollama 400s
   *  with "does not support thinking"). */
  supportsReasoning?: boolean;
  /** Optional per-family effort control delivered IN the prompt (a system-prompt line) rather than
   *  via the OpenAI `reasoning_effort` body param. Returns the line to append for `level`, or null
   *  to add nothing. gpt-oss uses harmony `Reasoning: <level>`; muse uses `Reasoning strength:
   *  <level>`. `applyEffort` (agent/effort.ts) appends it to the system message. */
  reasoningDirective?(level: EffortLevel): string | null;
  /** Stop sequences sent with the request so generation halts at a turn/tool-result boundary.
   *  GLM needs this (its `<|observation|>` delimiter must stop generation); other families omit it. */
  stopSequences?: string[];
}
