import { CleetusError } from "../lib/errors";
import type { Provider } from "../providers/types";

/** Max concurrent embedding requests per batch. */
const BATCH_CONCURRENCY = 4;

export class Embedder {
  constructor(
    private readonly provider: Provider,
    readonly model: string,
  ) {}

  async embed(text: string): Promise<Float32Array> {
    const vec = await this.provider.embed(text, this.model);
    return Float32Array.from(vec);
  }

  /** Embed texts with bounded concurrency, preserving input order. Fail-fast. */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = new Array(texts.length);
    for (let start = 0; start < texts.length; start += BATCH_CONCURRENCY) {
      const slice = texts.slice(start, start + BATCH_CONCURRENCY);
      const vecs = await Promise.all(
        slice.map(async (t, j) => {
          try {
            return await this.embed(t);
          } catch (e) {
            const code = e instanceof CleetusError ? e.code : "PROVIDER_INVALID_RESPONSE";
            throw new CleetusError(
              code,
              `embedding item ${start + j} failed: ${(e as Error).message}`,
              { cause: e },
            );
          }
        }),
      );
      for (let j = 0; j < vecs.length; j++) out[start + j] = vecs[j]!;
    }
    return out;
  }
}
