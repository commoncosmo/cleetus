import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "../../src/skills/discover";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("discoverSkills", () => {
  it("finds project skills in an ancestor .cleetus/skills and stamps source", async () => {
    const root = tmp("cleetus-skills-");
    mkdirSync(join(root, ".cleetus", "skills"), { recursive: true });
    writeFileSync(
      join(root, ".cleetus", "skills", "foo.md"),
      "---\nname: foo\ndescription: d\n---\nbody",
    );
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });

    const { skills } = await discoverSkills({
      startDir: sub,
      globalDir: tmp("cleetus-empty-global-"),
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "foo", description: "d", source: "project" });
  });

  it("loads skills from an explicit project home when cwd is elsewhere", async () => {
    const home = tmp("cleetus-skill-home-");
    const skillsDir = join(home, ".cleetus", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "home-skill.md"),
      "---\nname: home-skill\ndescription: from home\n---\nbody",
    );

    const { skills } = await discoverSkills({
      startDir: tmp("cleetus-unrelated-cwd-"),
      globalDir: tmp("cleetus-empty-global-home-"),
      projectHome: home,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "home-skill",
      description: "from home",
      source: "project",
    });
  });

  it("deduplicates project-home discovery when cwd is already inside that home", async () => {
    const home = tmp("cleetus-skill-same-home-");
    const skillsDir = join(home, ".cleetus", "skills");
    const cwd = join(home, "packages", "app");
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(skillsDir, "once.md"), "one body");

    const { skills } = await discoverSkills({
      startDir: cwd,
      globalDir: tmp("cleetus-empty-global-same-"),
      projectHome: home,
    });
    expect(skills.map((skill) => skill.name)).toEqual(["once"]);
  });

  it("lets explicit project-home skills override unrelated cwd project skills by name", async () => {
    const cwdRoot = tmp("cleetus-skill-cwd-root-");
    const home = tmp("cleetus-skill-explicit-home-");
    mkdirSync(join(cwdRoot, ".cleetus", "skills"), { recursive: true });
    mkdirSync(join(home, ".cleetus", "skills"), { recursive: true });
    writeFileSync(
      join(cwdRoot, ".cleetus", "skills", "shared.md"),
      "---\nname: shared\ndescription: cwd\n---\ncwd body",
    );
    writeFileSync(
      join(home, ".cleetus", "skills", "shared.md"),
      "---\nname: shared\ndescription: home\n---\nhome body",
    );

    const { skills } = await discoverSkills({
      startDir: cwdRoot,
      globalDir: tmp("cleetus-empty-global-precedence-"),
      projectHome: home,
    });
    expect(skills.map((skill) => skill.description)).toEqual(["cwd", "home"]);
  });

  it("reads global skills from <globalDir>/skills and ignores non-markdown", async () => {
    const globalDir = tmp("cleetus-global-");
    mkdirSync(join(globalDir, "skills"), { recursive: true });
    writeFileSync(join(globalDir, "skills", "bar.md"), "body for bar");
    writeFileSync(join(globalDir, "skills", "notes.txt"), "ignored");

    const { skills } = await discoverSkills({ startDir: tmp("cleetus-nostart-"), globalDir });
    expect(skills.map((s) => s.name)).toEqual(["bar"]);
    expect(skills[0]!.source).toBe("global");
  });

  it("skips an empty-body file and warns, keeping the others", async () => {
    const globalDir = tmp("cleetus-global2-");
    mkdirSync(join(globalDir, "skills"), { recursive: true });
    writeFileSync(join(globalDir, "skills", "empty.md"), "---\nname: empty\ndescription: d\n---\n");
    writeFileSync(join(globalDir, "skills", "ok.md"), "real body");

    const { skills, warnings } = await discoverSkills({
      startDir: tmp("cleetus-nostart2-"),
      globalDir,
    });
    expect(skills.map((s) => s.name)).toEqual(["ok"]);
    expect(warnings.some((w) => w.includes("empty.md"))).toBe(true);
  });

  it("returns nothing when no skill directories exist", async () => {
    const { skills, warnings } = await discoverSkills({
      startDir: tmp("cleetus-none-"),
      globalDir: tmp("cleetus-none-global-"),
    });
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("discovers a directory skill with baseDir and sorted resources (excluding SKILL.md)", async () => {
    const globalDir = tmp("cleetus-dirskill-");
    const skillDir = join(globalDir, "skills", "scan");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: scan\ndescription: d\n---\nBody");
    writeFileSync(join(skillDir, "reference.md"), "ref");
    writeFileSync(join(skillDir, "scripts", "run.sh"), "echo hi");

    const { skills } = await discoverSkills({ startDir: tmp("cleetus-nostart-a-"), globalDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "scan",
      description: "d",
      source: "global",
      baseDir: skillDir,
      resources: ["reference.md", "scripts/run.sh"],
    });
  });

  it("ignores a subdirectory that has no SKILL.md, without warning", async () => {
    const globalDir = tmp("cleetus-nodir-");
    mkdirSync(join(globalDir, "skills", "notaskill"), { recursive: true });
    writeFileSync(join(globalDir, "skills", "notaskill", "notes.md"), "just notes");

    const { skills, warnings } = await discoverSkills({
      startDir: tmp("cleetus-nostart-b-"),
      globalDir,
    });
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("leaves baseDir/resources undefined for a flat skill", async () => {
    const globalDir = tmp("cleetus-flat-");
    mkdirSync(join(globalDir, "skills"), { recursive: true });
    writeFileSync(join(globalDir, "skills", "flat.md"), "flat body");

    const { skills } = await discoverSkills({ startDir: tmp("cleetus-nostart-c-"), globalDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.baseDir).toBeUndefined();
    expect(skills[0]!.resources).toBeUndefined();
  });

  it("lets a directory skill override a same-named flat skill in the same dir, with a warning", async () => {
    const globalDir = tmp("cleetus-collide-");
    const skillsRoot = join(globalDir, "skills");
    mkdirSync(join(skillsRoot, "dup"), { recursive: true });
    writeFileSync(join(skillsRoot, "dup.md"), "---\nname: dup\ndescription: flat\n---\nflat");
    writeFileSync(
      join(skillsRoot, "dup", "SKILL.md"),
      "---\nname: dup\ndescription: dir\n---\ndir",
    );

    const { skills, warnings } = await discoverSkills({
      startDir: tmp("cleetus-nostart-d-"),
      globalDir,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "dup",
      description: "dir",
      baseDir: join(skillsRoot, "dup"),
    });
    expect(warnings.some((w) => w.includes("dup") && w.includes("shadows"))).toBe(true);
  });

  it("caps resources at 100 and warns", async () => {
    const globalDir = tmp("cleetus-cap-");
    const skillDir = join(globalDir, "skills", "big");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: big\ndescription: d\n---\nBody");
    for (let i = 0; i < 101; i++) {
      writeFileSync(join(skillDir, `f${String(i).padStart(3, "0")}.txt`), "x");
    }

    const { skills, warnings } = await discoverSkills({
      startDir: tmp("cleetus-nostart-e-"),
      globalDir,
    });
    expect(skills[0]!.resources).toHaveLength(100);
    expect(warnings.some((w) => w.includes("big") && w.includes("100"))).toBe(true);
  });

  it("warns when SKILL.md exists but cannot be read", async () => {
    // A directory named SKILL.md makes readFile throw EISDIR (a non-ENOENT read error).
    const globalDir = tmp("cleetus-unreadable-");
    const skillDir = join(globalDir, "skills", "broken");
    mkdirSync(join(skillDir, "SKILL.md"), { recursive: true });

    const { skills, warnings } = await discoverSkills({
      startDir: tmp("cleetus-nostart-f-"),
      globalDir,
    });
    expect(skills).toEqual([]);
    expect(warnings.some((w) => w.includes("broken"))).toBe(true);
  });
});
