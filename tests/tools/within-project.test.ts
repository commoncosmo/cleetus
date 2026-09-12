import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refuseIfOutsideProject } from "../../src/tools/within-project";

const ctx = (dir: string, allow?: boolean) => ({
  projectDir: dir,
  abortSignal: new AbortController().signal,
  allowOutsideProject: allow,
});

describe("refuseIfOutsideProject", () => {
  it("returns null for a path inside the project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-wp-"));
    expect(await refuseIfOutsideProject("src/x.ts", ctx(dir))).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses an outside path with actionable guidance when the hatch is off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-wp-"));
    const r = await refuseIfOutsideProject("/Users/jj/x", ctx(dir));
    expect(r?.ok).toBe(false);
    expect(r?.errorCode).toBe("OUT_OF_TREE");
    expect(r?.errorMessage).toContain("outside the project root");
    expect(r?.errorMessage).toContain("relative");
    await rm(dir, { recursive: true, force: true });
  });

  it("allows an outside path when the hatch is on", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-wp-"));
    expect(await refuseIfOutsideProject("/Users/jj/x", ctx(dir, true))).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});
