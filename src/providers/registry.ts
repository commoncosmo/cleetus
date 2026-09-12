import { CleetusError } from "../lib/errors";
import type { Provider } from "./types";

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();

  register(name: string, provider: Provider): void {
    this.providers.set(name, provider);
  }

  get(name: string): Provider {
    const p = this.providers.get(name);
    if (!p) throw new CleetusError("PROVIDER_UNREACHABLE", `provider '${name}' not registered`);
    return p;
  }

  names(): string[] {
    return [...this.providers.keys()];
  }
}
