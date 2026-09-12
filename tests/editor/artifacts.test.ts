import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArtifactEditTargets, resolveArtifactEditTarget } from "../../src/editor/artifacts";

describe("resolveArtifactEditTarget", () => {
  test("prefers a current artifact and accepts an explicit in-root path", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cleetus-artifact-"));
    await mkdir(join(projectDir, "docs", "specs"), { recursive: true });
    await writeFile(join(projectDir, "docs", "specs", "current.md"), "current");
    await writeFile(join(projectDir, "docs", "specs", "other.md"), "other");

    expect(
      resolveArtifactEditTarget({
        kind: "spec",
        projectDir,
        specsDir: "docs/specs",
        current: "docs/specs/current.md",
      }),
    ).toBe(await realpath(join(projectDir, "docs", "specs", "current.md")));
    expect(
      resolveArtifactEditTarget({
        kind: "spec",
        projectDir,
        specsDir: "docs/specs",
        requested: "docs/specs/other.md",
      }),
    ).toBe(await realpath(join(projectDir, "docs", "specs", "other.md")));
  });

  test("selects the newest artifact when no current path is available", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cleetus-artifact-"));
    const plans = join(projectDir, ".cleetus", "plans");
    await mkdir(plans, { recursive: true });
    const older = join(plans, "older.md");
    const newer = join(plans, "newer.md");
    await writeFile(older, "old");
    await writeFile(newer, "new");
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));

    expect(
      resolveArtifactEditTarget({
        kind: "plan",
        projectDir,
        specsDir: "docs/specs",
      }),
    ).toBe(await realpath(newer));
  });

  test("rejects missing artifacts and paths outside the owning artifact root", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cleetus-artifact-"));
    await mkdir(join(projectDir, "docs", "specs"), { recursive: true });
    await writeFile(join(projectDir, "outside.md"), "outside");

    expect(() =>
      resolveArtifactEditTarget({
        kind: "spec",
        projectDir,
        specsDir: "docs/specs",
        requested: "outside.md",
      }),
    ).toThrow("resolves outside");
    expect(() =>
      resolveArtifactEditTarget({
        kind: "plan",
        projectDir,
        specsDir: "docs/specs",
      }),
    ).toThrow("no plan artifact");
  });

  test("rejects an in-root symlink whose real target escapes the artifact root", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cleetus-artifact-"));
    const externalDir = await mkdtemp(join(tmpdir(), "cleetus-external-"));
    const specs = join(projectDir, "docs", "specs");
    await mkdir(specs, { recursive: true });
    const external = join(externalDir, "secret.md");
    await writeFile(external, "secret");
    await symlink(external, join(specs, "linked.md"));

    expect(() =>
      resolveArtifactEditTarget({
        kind: "spec",
        projectDir,
        specsDir: "docs/specs",
        requested: "docs/specs/linked.md",
      }),
    ).toThrow("resolves outside");
  });
});

describe("listArtifactEditTargets", () => {
  test("lists only direct Markdown files as project-relative paths", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cleetus-artifact-list-"));
    const specs = join(projectDir, "docs", "specs");
    await mkdir(join(specs, "nested"), { recursive: true });
    await writeFile(join(specs, "alpha.md"), "alpha");
    await writeFile(join(specs, "notes.txt"), "notes");
    await writeFile(join(specs, "nested", "hidden.md"), "hidden");

    expect(
      listArtifactEditTargets({
        kind: "spec",
        projectDir,
        specsDir: "docs/specs",
      }),
    ).toEqual(["docs/specs/alpha.md"]);
  });

  test("omits an artifact root that escapes the project through a symlink", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cleetus-artifact-list-"));
    const externalDir = await mkdtemp(join(tmpdir(), "cleetus-external-list-"));
    await writeFile(join(externalDir, "secret.md"), "secret");
    await mkdir(join(projectDir, "docs"), { recursive: true });
    await symlink(externalDir, join(projectDir, "docs", "specs"));

    expect(
      listArtifactEditTargets({
        kind: "spec",
        projectDir,
        specsDir: "docs/specs",
      }),
    ).toEqual([]);
  });
});
