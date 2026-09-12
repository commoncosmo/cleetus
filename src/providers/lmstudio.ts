import { fetchLMStudioModels } from "./native-context";
import { chatOpenAI, embedOpenAI, listModelsOpenAI } from "./openai-compat";
import type { ChatOptions, ModelInfo, Provider, StreamEvent } from "./types";

export interface LMStudioProviderOptions {
  baseUrl: string;
  apiKey?: string;
}

export class LMStudioProvider implements Provider {
  constructor(private readonly opts: LMStudioProviderOptions) {}

  async listModels(): Promise<ModelInfo[]> {
    try {
      return await fetchLMStudioModels(this.opts);
    } catch {
      // Native /api/v0 missing (older LM Studio) OR the host is unreachable; the OpenAI
      // fallback below re-throws PROVIDER_UNREACHABLE for a genuinely dead provider.
      return listModelsOpenAI(this.opts);
    }
  }

  chat(req: ChatOptions): AsyncIterable<StreamEvent> {
    return chatOpenAI(this.opts, req);
  }

  embed(text: string, model?: string): Promise<number[]> {
    return embedOpenAI(this.opts, text, model);
  }
}
