import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confineEditorCreation,
  confinedEditorRoot,
  confinedEditorTarget,
  confinedEditorTree,
} from "../../src/editor/paths";

describe("editor path confinement", () => {
  test("returns the real target when it remains inside the authoritative root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cleetus-editor-root-"));
    const file = join(root, "config.yaml");
    await writeFile(file, "rules: []\n");

    expect(confinedEditorTarget({ root, target: file, label: "config" })).toContain("config.yaml");
  });

  test("rejects file and root symlinks that escape their boundary", async () => {
    const project = await mkdtemp(join(tmpdir(), "cleetus-editor-project-"));
    const external = await mkdtemp(join(tmpdir(), "cleetus-editor-external-"));
    const externalFile = join(external, "secret");
    await writeFile(externalFile, "secret");
    const link = join(project, "linked");
    await symlink(externalFile, link);

    expect(() =>
      confinedEditorTarget({ root: project, target: link, label: "project config" }),
    ).toThrow("resolves outside");

    const linkedRoot = join(project, ".cleetus");
    await symlink(external, linkedRoot);
    expect(() =>
      confinedEditorRoot({
        boundary: project,
        root: linkedRoot,
        label: "project workflow root",
      }),
    ).toThrow("resolves outside");
  });

  test("rejects an escaping symlinked parent before a missing file is created", async () => {
    const project = await realpath(await mkdtemp(join(tmpdir(), "cleetus-editor-project-")));
    const external = await realpath(await mkdtemp(join(tmpdir(), "cleetus-editor-external-")));
    await symlink(external, join(project, ".cleetus"));

    expect(() =>
      confineEditorCreation({
        root: project,
        target: join(project, ".cleetus", "config.yaml"),
        label: "project configuration",
      }),
    ).toThrow("parent resolves outside");
  });

  test("rejects symlinks anywhere inside a directory skill", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cleetus-editor-skill-")));
    const skill = join(root, "review");
    await mkdir(join(skill, "references"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Review");
    await symlink("/tmp", join(skill, "references", "outside"));

    expect(() => confinedEditorTree({ root, target: skill, label: "skill 'review'" })).toThrow(
      "contains a symlink",
    );
  });
});
