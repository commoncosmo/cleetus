import {
  fetchOllamaContextLengths,
  fetchOllamaModelContext,
  fetchOllamaVision,
} from "./native-context";
import { chatOpenAI, embedOpenAI, listModelsOpenAI } from "./openai-compat";
import type { ChatOptions, ModelInfo, Provider, StreamEvent } from "./types";
import type { VisionSupport } from "./vision";

export interface OllamaProviderOptions {
  baseUrl: string;
  apiKey?: string;
}

export class OllamaProvider implements Provider {
  constructor(private readonly opts: OllamaProviderOptions) {}

  async listModels(): Promise<ModelInfo[]> {
    const models = await listModelsOpenAI(this.opts);
    const ctx = await fetchOllamaContextLengths(this.opts);
    if (ctx.size === 0) return models;
    return models.map((m) => {
      const c = ctx.get(m.id);
      return c !== undefined ? { ...m, contextLength: c } : m;
    });
  }

  chat(req: ChatOptions): AsyncIterable<StreamEvent> {
    return chatOpenAI(this.opts, req);
  }

  embed(text: string, model?: string): Promise<number[]> {
    return embedOpenAI(this.opts, text, model);
  }

  async probeModelContext(model: string): Promise<number | undefined> {
    return fetchOllamaModelContext(this.opts, model);
  }

  async supportsVision(model: string): Promise<VisionSupport> {
    return fetchOllamaVision(this.opts, model);
  }
}
