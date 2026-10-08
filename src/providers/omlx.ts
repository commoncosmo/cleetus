import { chatOpenAI, embedOpenAI, listModelsOpenAI } from "./openai-compat";
import type { ChatOptions, ModelInfo, Provider, StreamEvent } from "./types";

export interface OMLXProviderOptions {
  baseUrl: string;
  apiKey?: string;
}

/** oMLX uses OpenAI-compatible /v1 routes and reports its effective context window
 * in each model's max_model_len field. Older servers can omit that metadata. */
export class OMLXProvider implements Provider {
  constructor(private readonly opts: OMLXProviderOptions) {}

  listModels(): Promise<ModelInfo[]> {
    return listModelsOpenAI({ ...this.opts, modelContextLengthField: "max_model_len" });
  }

  chat(req: ChatOptions): AsyncIterable<StreamEvent> {
    return chatOpenAI(this.opts, req);
  }

  embed(text: string, model?: string): Promise<number[]> {
    return embedOpenAI(this.opts, text, model);
  }
}
