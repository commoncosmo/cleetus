import { chatOpenAI, embedOpenAI, listModelsOpenAI } from "./openai-compat";
import type { ChatOptions, ModelInfo, Provider, StreamEvent } from "./types";

export interface VLLMProviderOptions {
  baseUrl: string;
  apiKey?: string;
}

/** vLLM's OpenAI-compatible routes expose the served context limit in max_model_len.
 * Tool/reasoning parsers are configured on the server for the selected model. */
export class VLLMProvider implements Provider {
  constructor(private readonly opts: VLLMProviderOptions) {}

  listModels(): Promise<ModelInfo[]> {
    return listModelsOpenAI({ ...this.opts, modelContextLengthField: "max_model_len" });
  }

  chat(req: ChatOptions): AsyncIterable<StreamEvent> {
    return chatOpenAI(this.opts, req);
  }

  embed(text: string, model?: string, options?: { signal?: AbortSignal }): Promise<number[]> {
    return embedOpenAI(this.opts, text, model, options);
  }
}
