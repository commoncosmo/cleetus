import { CleetusError } from "../lib/errors";
import { LlamaCppProvider } from "./llama-cpp";
import { LMStudioProvider } from "./lmstudio";
import { OllamaProvider } from "./ollama";
import { OMLXProvider } from "./omlx";
import { StrataProvider } from "./strata";
import type { Provider } from "./types";
import { VLLMProvider } from "./vllm";

export function buildProvider(
  type: string,
  baseUrl: string,
  apiKey?: string,
  options: { contextLength?: number; metadataUrl?: string } = {},
): Provider {
  if (type === "strata")
    return new StrataProvider({
      baseUrl,
      apiKey,
      contextLength: options.contextLength,
      metadataUrl: options.metadataUrl,
    });
  if (type === "lmstudio") return new LMStudioProvider({ baseUrl, apiKey });
  if (type === "ollama") return new OllamaProvider({ baseUrl, apiKey });
  if (type === "llama.cpp") return new LlamaCppProvider({ baseUrl, apiKey });
  if (type === "omlx") return new OMLXProvider({ baseUrl, apiKey });
  if (type === "vllm") return new VLLMProvider({ baseUrl, apiKey });
  throw new CleetusError("CONFIG_INVALID", `unknown provider type: ${type}`);
}
