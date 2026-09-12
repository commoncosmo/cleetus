import {
  fetchLlamaCppProps,
  llamaCppReadinessWarnings,
  parseLlamaCppContext,
} from "./native-context";
import { chatOpenAI, embedOpenAI, listModelsOpenAI } from "./openai-compat";
import type { ChatOptions, ModelInfo, Provider, StreamEvent, WindowInfo } from "./types";

export interface LlamaCppProviderOptions {
  baseUrl: string;
  apiKey?: string;
}

/** llama-server adapter. Chat, model listing, and embeddings use its OpenAI-compatible /v1
 * routes; /props supplies the effective context window and template capability diagnostics. */
export class LlamaCppProvider implements Provider {
  private readonly props = new Map<string, Promise<unknown | undefined>>();

  constructor(private readonly opts: LlamaCppProviderOptions) {}

  listModels(): Promise<ModelInfo[]> {
    return listModelsOpenAI(this.opts);
  }

  chat(req: ChatOptions): AsyncIterable<StreamEvent> {
    return chatOpenAI({ ...this.opts, responseFormatStyle: "llama.cpp" }, req);
  }

  embed(text: string, model?: string): Promise<number[]> {
    return embedOpenAI(this.opts, text, model);
  }

  private propsFor(model: string): Promise<unknown | undefined> {
    const existing = this.props.get(model);
    if (existing) return existing;
    const request = fetchLlamaCppProps(this.opts, model).catch(() => undefined);
    this.props.set(model, request);
    return request;
  }

  async probeModelContextInfo(model: string): Promise<WindowInfo | undefined> {
    const window = parseLlamaCppContext(await this.propsFor(model));
    return window === undefined ? undefined : { window, source: "loaded" };
  }

  async readinessWarnings(model: string): Promise<string[]> {
    return llamaCppReadinessWarnings(await this.propsFor(model));
  }
}
