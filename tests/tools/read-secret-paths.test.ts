import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyPatchTool } from "../../src/tools/apply-patch/tool";
import { EditFileTool } from "../../src/tools/edit-file";
import { GlobTool } from "../../src/tools/glob";
import { GrepTool } from "../../src/tools/grep";
import { MultiEditTool } from "../../src/tools/multi-edit";
import { ReadFileTool } from "../../src/tools/read-file";
import { refuseIfSecretPath } from "../../src/tools/read-guard";
import type { ToolContext } from "../../src/tools/types";
import { WriteFileTool } from "../../src/tools/write-file";

const wrapPatch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

let home: string;
let project: string;

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    projectDir: project,
    abortSignal: new AbortController().signal,
    homeDir: home,
    ...over,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cleetus-home-"));
  project = await mkdtemp(join(tmpdir(), "cleetus-proj-"));
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, ".ssh", "id_rsa"), "SECRET KEY MATERIAL");
  await writeFile(join(project, "ok.txt"), "fine");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe("refuseIfSecretPath", () => {
  it("refuses an absolute secret path", async () => {
    const r = await refuseIfSecretPath(join(home, ".ssh", "id_rsa"), ctx());
    expect(r?.ok).toBe(false);
    expect(r?.errorCode).toBe("SECRET_PATH");
  });

  it("refuses ../ traversal that lands in a secret dir", async () => {
    // project and home are sibling temp dirs; walk from project into home/.ssh
    const rel = join("..", home.split("/").pop()!, ".ssh", "id_rsa");
    const r = await refuseIfSecretPath(rel, ctx());
    expect(r?.errorCode).toBe("SECRET_PATH");
  });

  it("refuses an in-project symlink pointing at a secret", async () => {
    await symlink(join(home, ".ssh", "id_rsa"), join(project, "innocent.txt"));
    const r = await refuseIfSecretPath("innocent.txt", ctx());
    expect(r?.errorCode).toBe("SECRET_PATH");
  });

  it("is NOT bypassed by the allowOutsideProject session hatch", async () => {
    const r = await refuseIfSecretPath(
      join(home, ".ssh", "id_rsa"),
      ctx({ allowOutsideProject: true }),
    );
    expect(r?.errorCode).toBe("SECRET_PATH");
  });

  it("passes ordinary in-project and out-of-project paths", async () => {
    expect(await refuseIfSecretPath("ok.txt", ctx())).toBeNull();
    expect(await refuseIfSecretPath(join(home, "notes.txt"), ctx())).toBeNull();
    expect(await refuseIfSecretPath(undefined, ctx())).toBeNull();
  });
});

describe("read tools refuse secret paths end-to-end", () => {
  it("read_file", async () => {
    const r = await new ReadFileTool().run({ path: join(home, ".ssh", "id_rsa") }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
    expect(r.errorMessage ?? "").not.toContain("SECRET KEY MATERIAL");
  });

  it("glob with a secret cwd", async () => {
    const r = await new GlobTool().run({ pattern: "*", cwd: join(home, ".ssh") }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
  });

  it("grep with a secret path", async () => {
    const r = await new GrepTool().run({ pattern: "KEY", path: join(home, ".ssh") }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
  });

  it("read_file still reads normal files", async () => {
    const r = await new ReadFileTool().run({ path: "ok.txt" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("fine");
  });
});

describe("glob/grep pattern traversal is guarded (not just cwd/path)", () => {
  it("glob pattern traversing into a secret dir is refused even though dot:false would hide it", async () => {
    const homeBase = home.split("/").pop()!;
    const r = await new GlobTool().run({ pattern: `../${homeBase}/.ssh/*`, cwd: project }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
  });

  it("glob pattern with '..' after a wildcard segment is refused as TOOL_FAILED", async () => {
    const r = await new GlobTool().run({ pattern: "*/../../x" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("TOOL_FAILED");
    expect(r.errorMessage ?? "").toContain("..");
  });

  it("grep file_pattern traversing into a secret dir is refused", async () => {
    const homeBase = home.split("/").pop()!;
    const r = await new GrepTool().run(
      { pattern: "KEY", file_pattern: `../${homeBase}/.ssh/*`, path: project },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
  });

  it("grep file_pattern with '..' after a wildcard segment is refused as TOOL_FAILED", async () => {
    const r = await new GrepTool().run({ pattern: "KEY", file_pattern: "*/../../x" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("TOOL_FAILED");
    expect(r.errorMessage ?? "").toContain("..");
  });

  it("in-project glob patterns still work", async () => {
    await writeFile(join(project, "ok.txt"), "fine");
    const r = await new GlobTool().run({ pattern: "*.txt" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output ?? "").toContain("ok.txt");
  });
});

describe("write tools refuse secret-path pre-reads", () => {
  it("write_file to an in-project symlink pointing at a secret refuses without leaking content", async () => {
    await symlink(join(home, ".ssh", "id_rsa"), join(project, "innocent.txt"));
    const r = await new WriteFileTool().run(
      { path: "innocent.txt", content: "overwritten" },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
    expect(r.errorMessage ?? "").not.toContain("SECRET KEY MATERIAL");
    expect(JSON.stringify(r)).not.toContain("SECRET KEY MATERIAL");
  });

  it("edit_file on that same symlink refuses", async () => {
    await symlink(join(home, ".ssh", "id_rsa"), join(project, "innocent.txt"));
    const r = await new EditFileTool().run(
      { path: "innocent.txt", old_text: "SECRET", new_text: "pwned" },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
    expect(r.errorMessage ?? "").not.toContain("SECRET KEY MATERIAL");
    expect(JSON.stringify(r)).not.toContain("SECRET KEY MATERIAL");
  });

  it("edit_file with allowOutsideProject on an absolute secret path still refuses (hatch does not bypass)", async () => {
    const r = await new EditFileTool().run(
      { path: join(home, ".ssh", "id_rsa"), old_text: "SECRET", new_text: "pwned" },
      ctx({ allowOutsideProject: true }),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
    expect(r.errorMessage ?? "").not.toContain("SECRET KEY MATERIAL");
    expect(JSON.stringify(r)).not.toContain("SECRET KEY MATERIAL");
  });

  it("write_file to a normal in-project path still works", async () => {
    const r = await new WriteFileTool().run({ path: "ok.txt", content: "updated" }, ctx());
    expect(r.ok).toBe(true);
  });

  it("multi_edit on an in-project symlink pointing at a secret refuses", async () => {
    await symlink(join(home, ".ssh", "id_rsa"), join(project, "innocent.txt"));
    const r = await new MultiEditTool().run(
      { path: "innocent.txt", edits: [{ old_text: "SECRET", new_text: "pwned" }] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
    expect(JSON.stringify(r)).not.toContain("SECRET KEY MATERIAL");
  });

  it("apply_patch targeting an in-project symlink pointing at a secret refuses", async () => {
    await symlink(join(home, ".ssh", "id_rsa"), join(project, "innocent.txt"));
    const patch = wrapPatch("*** Update File: innocent.txt\n@@\n-SECRET\n+pwned");
    const r = await new ApplyPatchTool().run({ patch }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SECRET_PATH");
    expect(JSON.stringify(r)).not.toContain("SECRET KEY MATERIAL");
  });
});
