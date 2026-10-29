import { CleetusError } from "../lib/errors";
import { detectFamily } from "./families";
import { fetchMetadata } from "./metadata";
import {
  fetchLlamaCppProps,
  llamaCppReadinessWarnings,
  parseLlamaCppContext,
} from "./native-context";
import { chatOpenAI, embedOpenAI } from "./openai-compat";
import {
  type ChatOptions,
  type ModelInfo,
  type Provider,
  type StreamEvent,
  type WindowInfo,
  usableContextLength,
} from "./types";

export interface StrataProviderOptions {
  baseUrl: string;
  apiKey?: string;
  contextLength?: number;
}

/** Strata's OpenAI API, including desktop-router aliases and optional native /props. */
export class StrataProvider implements Provider {
  private readonly labels = new Map<string, string>();
  private metadata?: Promise<void>;
  private readonly props = new Map<string, { time: number; value: Promise<unknown | undefined> }>();
  constructor(private readonly opts: StrataProviderOptions) {}

  async listModels(): Promise<ModelInfo[]> {
    let response: Response;
    try {
      response = await fetchMetadata(`${this.opts.baseUrl}/v1/models`, {
        headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
      });
    } catch (cause) {
      throw new CleetusError("PROVIDER_UNREACHABLE", "Cannot reach Strata model endpoint", {
        cause,
      });
    }
    if (!response.ok)
      throw new CleetusError(
        "PROVIDER_UNREACHABLE",
        `Strata models request failed (${response.status})`,
      );
    const json = (await response.json()) as {
      data?: { id?: unknown; meta?: { label?: unknown } }[];
    };
    if (!Array.isArray(json.data))
      throw new CleetusError(
        "PROVIDER_INVALID_RESPONSE",
        "Strata model list is missing data array",
      );
    this.labels.clear();
    return json.data.flatMap((row) => {
      if (!row || typeof row.id !== "string") return [];
      if (typeof row.meta?.label === "string") this.labels.set(row.id, row.meta.label);
      return [{ id: row.id }];
    });
  }

  async *chat(req: ChatOptions): AsyncIterable<StreamEvent> {
    req.signal?.throwIfAborted();
    // Startup normally lists models. Direct callers also need alias metadata, but a
    // metadata outage must never turn a usable chat endpoint into a hard dependency.
    if (
      !this.labels.has(req.model) &&
      !detectFamily(req.model) &&
      !req.modelFamily?.override &&
      req.modelFamily?.enabled !== false
    ) {
      this.metadata ??= this.listModels().then(
        () => {},
        () => {
          this.metadata = undefined;
        },
      );
      if (req.signal) {
        const signal = req.signal;
        let onAbort: () => void = () => {};
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        try {
          await Promise.race([this.metadata, cancelled]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      } else {
        await this.metadata;
      }
    }
    const family = detectFamily(this.labels.get(req.model) ?? "");
    const shaped: ChatOptions = {
      ...req,
      modelFamily: {
        ...req.modelFamily,
        override: req.modelFamily?.override ?? detectFamily(req.model)?.name ?? family?.name,
      },
    };
    if (req.responseFormat?.kind === "tool-call" && req.tools?.length) {
      shaped.messages = [
        ...req.messages,
        {
          role: "user",
          content: `Return the requested JSON tool-call envelope. Choose from these tool definitions and provide valid arguments: ${JSON.stringify(req.tools)}`,
        },
      ];
    }
    yield* chatOpenAI({ ...this.opts, omitToolsWithResponseFormat: true }, shaped);
  }

  embed(text: string, model?: string, options?: { signal?: AbortSignal }): Promise<number[]> {
    return embedOpenAI(this.opts, text, model, options);
  }

  private propsFor(model: string): Promise<unknown | undefined> {
    const cached = this.props.get(model);
    if (cached && Date.now() - cached.time < 5000) return cached.value;
    const value = fetchLlamaCppProps(this.opts, model)
      .then((props) => {
        const alias = (props as { model_alias?: unknown } | null)?.model_alias;
        return typeof alias === "string" && alias !== model ? undefined : props;
      })
      .catch(() => undefined);
    this.props.set(model, { time: Date.now(), value });
    return value;
  }

  async probeModelContextInfo(model: string): Promise<WindowInfo | undefined> {
    const window = parseLlamaCppContext(await this.propsFor(model));
    if (window !== undefined) return { window, source: "loaded" };
    const configured = usableContextLength(this.opts.contextLength);
    return configured === undefined ? undefined : { window: configured, source: "configured" };
  }

  async readinessWarnings(model: string): Promise<string[]> {
    const props = await this.propsFor(model);
    const warnings = llamaCppReadinessWarnings(props);
    if (parseLlamaCppContext(props) === undefined)
      warnings.push(
        this.opts.contextLength
          ? `Strata context metadata unavailable; using configured context_length: ${this.opts.contextLength}. Keep it within the server's actual served window.`
          : "Strata context window unknown: expose /props or set this provider's context_length to its actual served window. Cleetus retains conservative context budgeting.",
      );
    return warnings;
  }
}
