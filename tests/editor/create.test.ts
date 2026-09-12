import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfinedEditorTarget } from "../../src/editor/create";

function temporaryProject(run: (project: string) => void): void {
  const project = mkdtempSync(join(tmpdir(), "cleetus-editor-create-"));
  try {
    run(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

describe("project-confined editor creation", () => {
  test("creates missing parents and one empty file", () => {
    temporaryProject((project) => {
      const target = createConfinedEditorTarget({
        root: project,
        target: join(project, "notes", "decisions", "editor.md"),
      });

      expect(target).toBe(join(project, "notes", "decisions", "editor.md"));
      expect(lstatSync(target).isFile()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("");
    });
  });

  test("never overwrites an existing file", () => {
    temporaryProject((project) => {
      const target = join(project, "existing.md");
      writeFileSync(target, "keep me");

      expect(() =>
        createConfinedEditorTarget({
          root: project,
          target,
        }),
      ).toThrow("already exists");
      expect(readFileSync(target, "utf8")).toBe("keep me");
    });
  });

  test("rejects lexical escapes from the project", () => {
    temporaryProject((project) => {
      expect(() =>
        createConfinedEditorTarget({
          root: project,
          target: join(project, "..", "outside.md"),
        }),
      ).toThrow("inside the project");
    });
  });

  test.skipIf(process.platform === "win32")("rejects symlinked parent directories", () => {
    temporaryProject((project) => {
      const outside = mkdtempSync(join(tmpdir(), "cleetus-editor-outside-"));
      try {
        symlinkSync(outside, join(project, "linked"));
        expect(() =>
          createConfinedEditorTarget({
            root: project,
            target: join(project, "linked", "outside.md"),
          }),
        ).toThrow("must not be a symlink");
        expect(() => lstatSync(join(outside, "outside.md"))).toThrow();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});
