import { CleetusError } from "../lib/errors";
import { LlamaCppProvider } from "./llama-cpp";
import { LMStudioProvider } from "./lmstudio";
import { OllamaProvider } from "./ollama";
import type { Provider } from "./types";

export function buildProvider(type: string, baseUrl: string, apiKey?: string): Provider {
  if (type === "lmstudio") return new LMStudioProvider({ baseUrl, apiKey });
  if (type === "ollama") return new OllamaProvider({ baseUrl, apiKey });
  if (type === "llama.cpp") return new LlamaCppProvider({ baseUrl, apiKey });
  throw new CleetusError("CONFIG_INVALID", `unknown provider type: ${type}`);
}
