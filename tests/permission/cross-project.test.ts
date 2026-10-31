import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { unexpectedCleetusProjectReference } from "../../src/permission/cross-project";

const roots: string[] = [];

async function fixture(): Promise<{ active: string; sibling: string }> {
  const base = join(
    tmpdir(),
    `cleetus-cross-project-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const active = join(base, "todo6");
  const sibling = join(base, "todo7");
  roots.push(base);
  await mkdir(join(active, ".cleetus"), { recursive: true });
  await mkdir(join(sibling, ".cleetus"), { recursive: true });
  await writeFile(join(sibling, "package.json"), "{}");
  return { active, sibling };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

describe("unexpectedCleetusProjectReference", () => {
  it("blocks an unexplained sibling path embedded in a bash command", async () => {
    const { active, sibling } = await fixture();
    expect(
      await unexpectedCleetusProjectReference(
        "bash",
        { command: `ls -la ${sibling}/ && pwd` },
        active,
        "Implement the approved spec.",
      ),
    ).toEqual({ rawPath: `${sibling}/`, projectRoot: sibling });
  });

  it("blocks structured read tools rooted in another Cleetus project", async () => {
    const { active, sibling } = await fixture();
    expect(
      await unexpectedCleetusProjectReference(
        "glob",
        { cwd: sibling, pattern: "**/*" },
        active,
        "Inspect this project.",
      ),
    ).toEqual({ rawPath: sibling, projectRoot: sibling });
  });

  it("allows a sibling project explicitly named by the user", async () => {
    const { active, sibling } = await fixture();
    expect(
      await unexpectedCleetusProjectReference(
        "read_file",
        { path: join(sibling, "package.json") },
        active,
        `Compare this project with ${sibling}.`,
      ),
    ).toBeNull();
  });

  it("does not interfere with active-project or ordinary external paths", async () => {
    const { active } = await fixture();
    expect(
      await unexpectedCleetusProjectReference(
        "bash",
        { command: `ls ${join(active, "src")} /usr/bin` },
        active,
        "Inspect the source.",
      ),
    ).toBeNull();
  });
});
