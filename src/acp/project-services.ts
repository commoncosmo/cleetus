import type { Database } from "bun:sqlite";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { projectCheckpointMirrorDir } from "../agent/recovery-path";
import { buildCheckpointStore } from "../checkpoint";
import type { CheckpointBackend, CheckpointRecorder } from "../checkpoint/types";
import { Indexer } from "../codeindex/indexer";
import { Manifest } from "../codeindex/manifest";
import type { CleetusConfig } from "../config/types";
import { buildDiagnosticsManager } from "../diagnostics";
import type { DiagnosticsManager } from "../diagnostics/manager";
import type { DiagnosticExec } from "../diagnostics/types";
import type { EventLog } from "../events/log";
import { buildFormatter } from "../format/manager";
import type { Formatter } from "../format/types";
import { shellJoin } from "../git/quote";
import { buildHookEngine } from "../hooks";
import type { HookEngine } from "../hooks/types";
import type { ProviderRegistry } from "../providers/registry";
import { buildRepoMap } from "../repomap/build";
import type { Sandbox } from "../sandbox/types";
import { Embedder } from "../vector/embedder";
import { VectorService } from "../vector/service";

export interface AcpProjectServices {
  cwd: string;
  config: CleetusConfig;
  repoMap: string;
  diagnostics?: DiagnosticsManager;
  formatter: Formatter;
  hooks?: HookEngine;
  checkpoints?: CheckpointBackend;
  vectors: VectorService;
  indexer: Indexer;
  dispose(): void;
}

export interface AcpProjectServiceHolder {
  current?: AcpProjectServices;
}

type LoadProjectConfig = (cwd: string) => Promise<CleetusConfig>;

/** Canonicalize an ACP session cwd for cache identity. A missing/deleted directory remains a
 * resolved absolute path so the eventual tool error is useful instead of failing session setup. */
export async function canonicalProjectCwd(cwd: string): Promise<string> {
  const absolute = resolve(cwd);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Lazily constructs runtime-quality services once per project root. The registry owns no global
 * "active" state; AcpProjectServiceHolder selects one bundle only while the connection FIFO owns
 * the shared AgentRuntime adapters.
 */
export class AcpProjectServiceRegistry {
  private readonly byCwd = new Map<string, Promise<AcpProjectServices>>();
  private readonly built = new Set<AcpProjectServices>();

  constructor(
    private readonly deps: {
      loadConfig: LoadProjectConfig;
      sandbox: Sandbox;
      log: EventLog;
      db: Database;
      globalDir: string;
      providers: ProviderRegistry;
      onWarning?: (message: string) => void;
    },
  ) {}

  async get(rawCwd: string): Promise<AcpProjectServices> {
    const cwd = await canonicalProjectCwd(rawCwd);
    const existing = this.byCwd.get(cwd);
    if (existing) return existing;
    const pending = this.build(cwd);
    this.byCwd.set(cwd, pending);
    try {
      const services = await pending;
      this.built.add(services);
      return services;
    } catch (error) {
      this.byCwd.delete(cwd);
      throw error;
    }
  }

  dispose(): void {
    for (const services of this.built) services.dispose();
    this.built.clear();
    this.byCwd.clear();
  }

  private async build(cwd: string): Promise<AcpProjectServices> {
    const config = await this.deps.loadConfig(cwd);
    const repoMap = config.repoMap.enabled
      ? await buildRepoMap({ projectDir: cwd, tokenBudget: config.repoMap.tokenBudget })
      : "";
    const exec: DiagnosticExec = (argv, opts) =>
      this.deps.sandbox.exec(shellJoin(argv), {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
    const { manager: diagnostics, warnings } = await buildDiagnosticsManager(
      config.diagnostics,
      cwd,
      exec,
    );
    for (const warning of warnings) this.deps.onWarning?.(warning);

    const formatter = await buildFormatter(config.format, {
      projectDir: cwd,
      deps: {
        which: (bin) => Bun.which(bin),
        fileExists: (path) => Bun.file(path).exists(),
        readFile: (path) => Bun.file(path).text(),
        spawn: async (argv, opts) => {
          const result = await this.deps.sandbox.exec(shellJoin(argv), {
            cwd: opts.cwd,
            timeoutMs: 15_000,
            signal: opts.signal,
          });
          return { exitCode: result.exitCode };
        },
      },
    });
    const hooks = buildHookEngine(config.hooks, {
      sandbox: this.deps.sandbox,
      log: this.deps.log,
    });
    const checkpoints = await buildCheckpointStore(config.checkpoint, {
      sandbox: this.deps.sandbox,
      projectDir: cwd,
      db: this.deps.db,
      mirrorDir: projectCheckpointMirrorDir(this.deps.globalDir, cwd),
    });
    let embedder: Embedder | null = null;
    if (config.embeddings) {
      if (this.deps.providers.names().includes(config.embeddings.provider)) {
        embedder = new Embedder(
          this.deps.providers.get(config.embeddings.provider),
          config.embeddings.model,
        );
      } else {
        this.deps.onWarning?.(
          `embeddings.provider '${config.embeddings.provider}' is not configured; code search disabled`,
        );
      }
    }
    const vectors = new VectorService({
      projectDbPath: join(cwd, ".cleetus", "vectors.db"),
      globalDbPath: join(this.deps.globalDir, "vectors.db"),
      embedder,
    });
    const manifest = new Manifest(join(cwd, ".cleetus", "code-index.db"));
    const indexer = new Indexer({
      projectDir: cwd,
      vectorService: vectors,
      manifest,
      embedModel: embedder?.model ?? "",
    });
    const seed = new AbortController();
    diagnostics?.seed(seed.signal);
    await diagnostics?.whenSeeded();

    return {
      cwd,
      config,
      repoMap,
      diagnostics,
      formatter,
      hooks,
      checkpoints,
      vectors,
      indexer,
      dispose: () => {
        seed.abort();
        manifest.close();
        vectors.close();
      },
    };
  }
}

/** Dynamic adapters passed once to AgentRuntime. They resolve the active bundle at each call so
 * the runtime remains shared while diagnostics/formatting/hooks/checkpoints stay project-scoped. */
export function projectServiceAdapters(holder: AcpProjectServiceHolder): {
  diagnostics: {
    check: DiagnosticsManager["check"];
    checkFiles: DiagnosticsManager["checkFiles"];
  };
  formatter: Formatter;
  hooks: HookEngine;
  checkpoints: CheckpointRecorder;
} {
  return {
    diagnostics: {
      check: (file, signal) =>
        holder.current?.diagnostics?.check(file, signal) ?? Promise.resolve(null),
      checkFiles: (files, signal) =>
        holder.current?.diagnostics?.checkFiles(files, signal) ?? Promise.resolve([]),
    },
    formatter: {
      formatFiles: (files, signal) =>
        holder.current?.formatter.formatFiles(files, signal) ?? Promise.resolve([]),
    },
    hooks: {
      runPreToolUse: (input) =>
        holder.current?.hooks?.runPreToolUse(input) ?? Promise.resolve({ allow: true }),
      runPostToolUse: (input) =>
        holder.current?.hooks?.runPostToolUse(input) ?? Promise.resolve({}),
    },
    checkpoints: {
      begin: (sessionId, userInput, historyLength, todos) =>
        holder.current?.checkpoints?.begin(sessionId, userInput, historyLength, todos),
      recordFile: (path, before, created) =>
        holder.current?.checkpoints?.recordFile(path, before, created),
    },
  };
}
