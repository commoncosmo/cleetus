#!/usr/bin/env bun
/**
 * Manual smoke test for the vector-store foundation.
 *
 * Exercises the ONE path the automated suite can't: the real embedding HTTP
 * round-trip (provider.embed -> /v1/embeddings) composed with VectorService.
 * The unit tests all use a fake provider, so this is the only check that the
 * live wiring actually produces sensible, semantically-ranked results.
 *
 * Requires a running embedding endpoint. Defaults to Ollama + nomic-embed-text.
 *   bun scripts/smoke-vector.ts
 *   EMBED_BASE_URL=http://localhost:1234 EMBED_MODEL=text-embedding-nomic-embed-text-v1.5 bun scripts/smoke-vector.ts
 *
 * Not part of the test suite and not wired into the app — throwaway verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CleetusError } from "../src/lib/errors";
import { LMStudioProvider } from "../src/providers/lmstudio";
import { OllamaProvider } from "../src/providers/ollama";
import { Embedder } from "../src/vector/embedder";
import { VectorService } from "../src/vector/service";

const BASE_URL = process.env.EMBED_BASE_URL ?? "http://localhost:11434";
const MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text:latest";

// A SECOND, real embedding model with a DIFFERENT name (defaults to LM Studio's
// nomic). Used to exercise the mismatch guard honestly: the query embeds fine
// (real 768-dim vector) but the model name differs from the namespace stamp.
const ALT_BASE_URL = process.env.ALT_EMBED_BASE_URL ?? "http://localhost:1234";
const ALT_MODEL = process.env.ALT_EMBED_MODEL ?? "text-embedding-nomic-embed-text-v1.5";

const docs = [
  { id: "cat", text: "Cats are small domesticated felines that purr and chase mice." },
  { id: "dog", text: "Dogs are loyal canines often kept as pets and working animals." },
  { id: "rust", text: "Rust is a systems programming language focused on memory safety." },
  { id: "bun", text: "Bun is a fast JavaScript runtime, bundler, and package manager." },
];

const dir = mkdtempSync(join(tmpdir(), "cleetus-smoke-"));

function pass(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function fail(msg: string): never {
  console.error(`  \x1b[31m✗ ${msg}\x1b[0m`);
  process.exitCode = 1;
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

async function main() {
  console.log(`\nSmoke test: ${MODEL} @ ${BASE_URL}\n`);

  const provider = new OllamaProvider({ baseUrl: BASE_URL });
  const embedder = new Embedder(provider, MODEL);
  const svc = new VectorService({
    projectDbPath: join(dir, "project.db"),
    globalDbPath: join(dir, "global.db"),
    embedder,
  });

  // 1. enabled reflects the embedder
  svc.enabled ? pass("service reports enabled") : fail("service should be enabled");

  // 2. real embedding round-trip + index
  await svc.index("project", "docs", docs);
  const stats = svc.stats("project", "docs");
  stats.count === docs.length
    ? pass(`indexed ${stats.count} docs (model=${stats.model}, dim=${stats.dim})`)
    : fail(`expected ${docs.length} docs, got ${stats.count}`);

  // 3. semantic search — a query with NO shared keywords should still rank the cat doc first
  const q = "a purring feline pet";
  const hits = await svc.search("project", "docs", q, 4);
  console.log(`\n  query: "${q}"`);
  for (const h of hits) console.log(`    ${h.score.toFixed(4)}  ${h.id}`);
  hits[0]?.id === "cat"
    ? pass('top hit is "cat" (semantic match, not keyword overlap)')
    : fail(`expected "cat" first, got "${hits[0]?.id}"`);

  // 4. a programming query should rank a programming doc first
  const q2 = "memory-safe language for low-level software";
  const hits2 = await svc.search("project", "docs", q2, 1);
  hits2[0]?.id === "rust"
    ? pass('programming query ranks "rust" first')
    : fail(`expected "rust" first, got "${hits2[0]?.id}"`);

  // 5. scope isolation — global namespace is empty
  svc.stats("global", "docs").count === 0
    ? pass("global scope is isolated (empty)")
    : fail("global scope should be empty");

  svc.close();

  // 6. model-mismatch refusal — reopen the SAME db with a DIFFERENT but real
  // model. The query embeds successfully, then the store's stamp guard refuses
  // to mix it with vectors built by the original model.
  const altProvider = new LMStudioProvider({ baseUrl: ALT_BASE_URL });
  const svc2 = new VectorService({
    projectDbPath: join(dir, "project.db"),
    globalDbPath: join(dir, "global.db"),
    embedder: new Embedder(altProvider, ALT_MODEL),
  });
  try {
    await svc2.search("project", "docs", "anything", 1);
    fail("expected EMBEDDING_MODEL_MISMATCH, but search succeeded");
  } catch (e) {
    e instanceof CleetusError && e.code === "EMBEDDING_MODEL_MISMATCH"
      ? pass(`refuses retrieval when the model changed (${(e as Error).message.split(" — ")[0]})`)
      : fail(`expected EMBEDDING_MODEL_MISMATCH, got ${(e as Error).message}`);
  } finally {
    svc2.close();
  }

  rmSync(dir, { recursive: true, force: true });
  console.log("\n\x1b[32mAll smoke checks passed.\x1b[0m\n");
}

main().catch((e) => {
  console.error(`\n\x1b[31mSmoke test errored:\x1b[0m ${(e as Error).message}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
