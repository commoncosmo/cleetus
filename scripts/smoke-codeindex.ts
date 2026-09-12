#!/usr/bin/env bun
/**
 * Manual smoke test for the code index — exercises the real embedding round-trip
 * end-to-end (indexer + code_search) against a live embedding endpoint.
 * Defaults to Ollama + nomic-embed-text. Not part of the test suite.
 *
 *   bun scripts/smoke-codeindex.ts
 */
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "../src/codeindex/indexer";
import { Manifest } from "../src/codeindex/manifest";
import { CodeSearchTool } from "../src/codeindex/search-tool";
import { OllamaProvider } from "../src/providers/ollama";
import { Embedder } from "../src/vector/embedder";
import { VectorService } from "../src/vector/service";

const BASE_URL = process.env.EMBED_BASE_URL ?? "http://localhost:11434";
const MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text:latest";

const dir = mkdtempSync(join(tmpdir(), "cleetus-ci-smoke-"));
function pass(m: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
}
function fail(m: string): never {
  console.error(`  \x1b[31m✗ ${m}\x1b[0m`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

async function main() {
  console.log(`\nCode-index smoke: ${MODEL} @ ${BASE_URL}\n`);
  await $`git init`.cwd(dir).quiet();
  writeFileSync(
    join(dir, "cats.ts"),
    "// felines\nexport function purr() { return 'a cat purrs softly'; }\n",
  );
  writeFileSync(
    join(dir, "memory.rs"),
    "// rust ownership\nfn borrow() { /* memory-safe by the borrow checker */ }\n",
  );
  writeFileSync(
    join(dir, "http.go"),
    "// web server\nfunc handler() { /* serves http requests */ }\n",
  );
  await $`git add -A`.cwd(dir).quiet();

  const provider = new OllamaProvider({ baseUrl: BASE_URL });
  const embedder = new Embedder(provider, MODEL);
  const vectorService = new VectorService({
    projectDbPath: join(dir, ".cleetus", "vectors.db"),
    globalDbPath: join(dir, ".cleetus", "global.db"),
    embedder,
  });
  const manifest = new Manifest(join(dir, ".cleetus", "code-index.db"));
  const indexer = new Indexer({ projectDir: dir, vectorService, manifest, embedModel: MODEL });

  const first = await indexer.run();
  first.indexedFiles === 3
    ? pass(`indexed ${first.indexedFiles} files (${first.indexedChunks} chunks)`)
    : fail(`expected 3 files, got ${first.indexedFiles}`);

  const second = await indexer.run();
  second.indexedFiles === 0 && second.skipped === 3
    ? pass("re-run is incremental (0 re-embedded, 3 unchanged)")
    : fail(`expected 0 indexed / 3 skipped, got ${second.indexedFiles}/${second.skipped}`);

  const tool = new CodeSearchTool(vectorService);
  const res = await tool.run(
    { query: "how does the borrow checker keep memory safe", k: 1 },
    {
      projectDir: dir,
      abortSignal: new AbortController().signal,
    },
  );
  console.log(`\n  query result:\n    ${(res.output ?? "").split("\n").join("\n    ")}\n`);
  res.output?.includes("memory.rs")
    ? pass('semantic query ranks "memory.rs" first')
    : fail(`expected memory.rs, got: ${res.output}`);

  vectorService.close();
  manifest.close();
  rmSync(dir, { recursive: true, force: true });
  console.log("\n\x1b[32mAll code-index smoke checks passed.\x1b[0m\n");
}

main().catch((e) => {
  console.error(`\n\x1b[31mSmoke errored:\x1b[0m ${(e as Error).message}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
