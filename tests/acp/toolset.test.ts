import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectFileBridge } from "../../src/acp/file-bridge";
import { registerAcpTools } from "../../src/acp/toolset";
import { loadConfig } from "../../src/config/loader";
import { MemoryStore } from "../../src/memory/store";
import { ProviderRegistry } from "../../src/providers/registry";
import { NoneSandbox } from "../../src/sandbox/none";
import { ToolRegistry } from "../../src/tools/registry";

let dir: string;
let globalDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-acp-toolset-"));
  globalDir = join(dir, "global");
  await mkdir(globalDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("registerAcpTools", () => {
  it("registers the safe terminal roster without orchestration-only subagents", async () => {
    const config = await loadConfig({
      globalPath: join(globalDir, "missing.yaml"),
      projectDir: dir,
    });
    const tools = new ToolRegistry();
    const toolset = await registerAcpTools({
      tools,
      fileBridge: new DirectFileBridge(),
      sandbox: new NoneSandbox(dir),
      config,
      projectDir: dir,
      projectScopeDir: dir,
      globalDir,
      providers: new ProviderRegistry(),
      memory: {
        global: new MemoryStore(join(globalDir, "memory.md")),
        project: new MemoryStore(join(dir, ".cleetus", "memory.md")),
      },
    });
    try {
      const names = tools
        .all()
        .map((tool) => tool.name)
        .sort();
      expect(names).toEqual(
        expect.arrayContaining([
          "apply_patch",
          "bash",
          "code_search",
          "edit_file",
          "glob",
          "grep",
          "multi_edit",
          "read_file",
          "remember",
          "save_fetched_json",
          "scaffold",
          "smoke_run",
          "todo_list_delete",
          "todo_list_load",
          "todo_list_save",
          "todo_list_show",
          "todo_list_write",
          "todo_write",
          "web_fetch",
          "web_search",
          "write_file",
        ]),
      );
      expect(names).not.toContain("task");
    } finally {
      toolset.dispose();
    }
  });
});
