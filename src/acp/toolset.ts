import { join } from "node:path";
import { type CodeSearchBackend, CodeSearchTool } from "../codeindex/search-tool";
import type { CleetusConfig } from "../config/types";
import { RememberTool } from "../memory/remember-tool";
import type { MemoryStore } from "../memory/store";
import type { MemoryScope } from "../memory/types";
import type { ProviderRegistry } from "../providers/registry";
import type { Sandbox } from "../sandbox/types";
import { ApplyPatchTool } from "../tools/apply-patch/tool";
import { BashTool } from "../tools/bash";
import { EditFileTool } from "../tools/edit-file";
import { buildGitTools } from "../tools/git";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";
import { MultiEditTool } from "../tools/multi-edit";
import { ReadFileTool } from "../tools/read-file";
import type { ToolRegistry } from "../tools/registry";
import { RenderCheckTool } from "../tools/render-check";
import { RequestEscalationTool } from "../tools/request-escalation";
import { RunTestsTool, buildTestRunner } from "../tools/run-tests";
import { SaveFetchedJsonTool } from "../tools/save-fetched-json";
import { ScaffoldTool } from "../tools/scaffold";
import { SmokeRunTool } from "../tools/smoke-run";
import {
  TodoListDeleteTool,
  TodoListLoadTool,
  TodoListSaveTool,
  TodoListShowTool,
  TodoListWriteTool,
} from "../tools/todo-list";
import { TodoListStore } from "../tools/todo-list-store";
import { TodoWriteTool } from "../tools/todo-write";
import { WebFetchTool } from "../tools/web-fetch";
import { WebSearchTool } from "../tools/web-search";
import { WriteFileTool } from "../tools/write-file";
import { Embedder } from "../vector/embedder";
import { VectorService } from "../vector/service";
import { WebFetchCache } from "../web/fetch-cache";
import type { FileBridge } from "./file-bridge";

export interface AcpToolset {
  warnings: string[];
  dispose(): void;
}

/**
 * Register the non-orchestration terminal tool roster for ACP. File and process tools receive
 * delegating adapters so each prompt can still route through client fs/terminal capabilities.
 * Subagents are intentionally excluded until the ACP runtime gains orchestration support.
 */
export async function registerAcpTools(input: {
  tools: ToolRegistry;
  fileBridge: FileBridge;
  sandbox: Sandbox;
  config: CleetusConfig;
  projectDir: string;
  projectScopeDir: string;
  globalDir: string;
  providers: ProviderRegistry;
  memory: { global: MemoryStore; project: MemoryStore };
  /** Default scope `remember` writes to when the caller doesn't specify one. Set from the launch
   *  scope's `defaultMemoryScope` (global for `--global`/`--scratch`, project otherwise). */
  rememberDefaultScope?: MemoryScope;
  /** Resolve semantic search from the active canonical project. When omitted, build the
   * historical launch-project service for standalone callers/tests. */
  codeSearchForProject?: (projectDir: string) => CodeSearchBackend | undefined;
}): Promise<AcpToolset> {
  const { tools, fileBridge, sandbox, config, projectDir, projectScopeDir, globalDir, providers } =
    input;
  const warnings: string[] = [];
  const todoStores = {
    global: new TodoListStore(join(globalDir, "todos")),
    project: new TodoListStore(join(projectScopeDir, ".cleetus", "todos")),
  };

  let vectors: VectorService | undefined;
  if (!input.codeSearchForProject) {
    let embedder: Embedder | null = null;
    if (config.embeddings) {
      if (providers.names().includes(config.embeddings.provider)) {
        embedder = new Embedder(providers.get(config.embeddings.provider), config.embeddings.model);
      } else {
        warnings.push(
          `embeddings.provider '${config.embeddings.provider}' is not configured; code search disabled`,
        );
      }
    }
    vectors = new VectorService({
      projectDbPath: join(projectScopeDir, ".cleetus", "vectors.db"),
      globalDbPath: join(globalDir, "vectors.db"),
      embedder,
    });
  }

  tools.register(new ReadFileTool(fileBridge));
  tools.register(new WriteFileTool(fileBridge));
  tools.register(new EditFileTool());
  tools.register(new MultiEditTool());
  tools.register(new ApplyPatchTool());
  tools.register(new TodoWriteTool());
  tools.register(new TodoListShowTool(todoStores));
  tools.register(new TodoListWriteTool(todoStores));
  tools.register(new TodoListDeleteTool(todoStores));
  tools.register(new TodoListSaveTool(todoStores));
  tools.register(new TodoListLoadTool(todoStores));
  tools.register(
    new BashTool(sandbox, { enforcePackageManager: config.packageManager.enforceBun }),
  );
  tools.register(new ScaffoldTool(sandbox));
  tools.register(new SmokeRunTool(sandbox, config.smokeRun));
  tools.register(
    new RenderCheckTool(sandbox, {
      timeoutMs: config.test.timeoutMs,
      maxOutputLines: config.test.maxOutputLines,
    }),
  );

  const { register: registerTests, resolve: resolveTests } = await buildTestRunner(
    config.test,
    projectDir,
    { registerForAnyProject: true },
  );
  if (registerTests) {
    tools.register(
      new RunTestsTool(sandbox, resolveTests, {
        timeoutMs: config.test.timeoutMs,
        maxOutputLines: config.test.maxOutputLines,
      }),
    );
  }

  const git = await buildGitTools({ sandbox, projectDir, registerForAnyProject: true });
  warnings.push(...git.warnings);
  for (const tool of git.tools) tools.register(tool);

  tools.register(new GlobTool());
  tools.register(new GrepTool());
  tools.register(new RequestEscalationTool());
  const webFetchCache = new WebFetchCache();
  tools.register(new WebFetchTool(config.webTools, { cache: webFetchCache }));
  tools.register(new SaveFetchedJsonTool(webFetchCache));
  tools.register(new WebSearchTool(config.webTools));
  tools.register(new CodeSearchTool(input.codeSearchForProject ?? vectors!));
  tools.register(new RememberTool(input.memory, input.rememberDefaultScope));

  return {
    warnings,
    dispose: () => vectors?.close(),
  };
}
