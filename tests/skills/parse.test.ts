import { describe, expect, it } from "bun:test";
import { parseSkillFile } from "../../src/skills/parse";

describe("parseSkillFile", () => {
  it("reads name and description from frontmatter and keeps the body", () => {
    const p = parseSkillFile(
      "---\nname: scan\ndescription: Find bugs\n---\nDo the thing.",
      "ignored.md",
    );
    expect(p).toEqual({ name: "scan", description: "Find bugs", body: "Do the thing." });
  });

  it("derives the name from the filename when there is no frontmatter", () => {
    const p = parseSkillFile("Just a body, no frontmatter.", "my-skill.md");
    expect(p).toEqual({
      name: "my-skill",
      description: "(user skill)",
      body: "Just a body, no frontmatter.",
    });
  });

  it("falls back to the filename name when frontmatter omits name", () => {
    const p = parseSkillFile("---\ndescription: Only a desc\n---\nbody", "fallback.md");
    expect(p).toEqual({ name: "fallback", description: "Only a desc", body: "body" });
  });

  it("defaults the description when frontmatter omits it", () => {
    const p = parseSkillFile("---\nname: x\n---\nbody", "x.md");
    expect(p).toEqual({ name: "x", description: "(user skill)", body: "body" });
  });

  it("returns null when the body is empty", () => {
    expect(parseSkillFile("---\nname: x\ndescription: y\n---\n   \n", "x.md")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const p = parseSkillFile("---\r\nname: crlf\r\ndescription: d\r\n---\r\nbody line", "x.md");
    expect(p).toEqual({ name: "crlf", description: "d", body: "body line" });
  });

  it("ignores a nested metadata block and keeps name/description", () => {
    const p = parseSkillFile(
      "---\nname: x\ndescription: d\nmetadata:\n  author: me\n  version: 2\n---\nbody",
      "x.md",
    );
    expect(p).toEqual({ name: "x", description: "d", body: "body" });
  });

  it("ignores a list-valued allowed-tools field", () => {
    const p = parseSkillFile(
      "---\nname: x\ndescription: d\nallowed-tools:\n  - read_file\n  - bash\n---\nbody",
      "x.md",
    );
    expect(p).toEqual({ name: "x", description: "d", body: "body" });
  });

  it("falls back to the default description when it is not a string", () => {
    const p = parseSkillFile("---\nname: x\ndescription: 1.0\n---\nbody", "x.md");
    expect(p).toEqual({ name: "x", description: "(user skill)", body: "body" });
  });

  it("treats malformed YAML frontmatter as no frontmatter (silent fallback)", () => {
    const p = parseSkillFile("---\nname: [unterminated\n---\nBODY", "mal.md");
    expect(p).toEqual({
      name: "mal",
      description: "(user skill)",
      body: "---\nname: [unterminated\n---\nBODY",
    });
  });
});

describe("parseSkillFile — trigger block", () => {
  const withFm = (fm: string) => `---\n${fm}\n---\nBody text here.`;

  it("normalizes a scalar `when` to a one-element list, match defaults to []", () => {
    const s = parseSkillFile(withFm("name: t\ntrigger:\n  when: coding-task"), "t.md");
    expect(s?.trigger).toEqual({ when: ["coding-task"], match: [] });
  });

  it("normalizes list `when`/`match` and trims entries", () => {
    const s = parseSkillFile(
      withFm("name: t\ntrigger:\n  when: [coding-task, other]\n  match: ['  tdd  ', 'test first']"),
      "t.md",
    );
    expect(s?.trigger).toEqual({ when: ["coding-task", "other"], match: ["tdd", "test first"] });
  });

  it("normalizes a scalar `match` to a one-element list", () => {
    const s = parseSkillFile(withFm("name: t\ntrigger:\n  match: tdd"), "t.md");
    expect(s?.trigger).toEqual({ when: [], match: ["tdd"] });
  });

  it("leaves trigger undefined when there is no trigger block", () => {
    const s = parseSkillFile(withFm("name: t\ndescription: d"), "t.md");
    expect(s?.trigger).toBeUndefined();
  });

  it("leaves trigger undefined when the block normalizes to empty", () => {
    const s = parseSkillFile(withFm("name: t\ntrigger:\n  when: []\n  match: []"), "t.md");
    expect(s?.trigger).toBeUndefined();
  });

  it("drops non-string entries and undefined-when values", () => {
    const s = parseSkillFile(withFm("name: t\ntrigger:\n  when: [coding-task, 3, null]"), "t.md");
    expect(s?.trigger).toEqual({ when: ["coding-task"], match: [] });
  });

  it("ignores a non-mapping trigger value (soft, no throw)", () => {
    const s = parseSkillFile(withFm("name: t\ntrigger: nonsense"), "t.md");
    expect(s?.trigger).toBeUndefined();
  });
});

describe("parseSkillFile — scope field", () => {
  it("parses scope: decompose from frontmatter", () => {
    const md = "---\nname: x\ndescription: d\nscope: decompose\n---\nbody";
    expect(parseSkillFile(md, "x.md")?.scope).toBe("decompose");
  });

  it("absent scope → undefined", () => {
    const md = "---\nname: x\ndescription: d\n---\nbody";
    expect(parseSkillFile(md, "x.md")?.scope).toBeUndefined();
  });

  it("unrecognized scope → undefined (treated as both by resolvers)", () => {
    const md = "---\nname: x\ndescription: d\nscope: bogus\n---\nbody";
    expect(parseSkillFile(md, "x.md")?.scope).toBeUndefined();
  });
});

describe("parseSkillFile — learned metadata", () => {
  it("parses legacy and revision provenance for Cleetus-managed playbooks", () => {
    const parsed = parseSkillFile(
      `---
name: learned
metadata:
  learned:
    source_session: newest
    source_sessions:
      - oldest
      - newest
    created_at: 2026-01-01T00:00:00.000Z
    updated_at: 2026-01-02T00:00:00.000Z
    revision: 3
---
Body`,
      "learned.md",
    );

    expect(parsed?.learned).toEqual({
      sourceSessions: ["oldest", "newest"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      revision: 3,
    });
  });

  it("adds a reusable intent anchor when loading a legacy learned playbook", () => {
    const parsed = parseSkillFile(
      `---
name: weather-forecast-summary
description: Retrieve and summarize weather forecasts.
trigger:
  match:
    - look up weather
    - current weather forecast
    - three bullet summary
metadata:
  learned:
    source_session: old
---
Body`,
      "weather-forecast-summary.md",
    );

    expect(parsed?.trigger?.match).toEqual([
      "weather",
      "look up weather",
      "current weather forecast",
      "three bullet summary",
    ]);
  });

  it("does not reinterpret triggers on ordinary user-authored skills", () => {
    const parsed = parseSkillFile(
      `---
name: weather-guide
description: Retrieve weather.
trigger:
  match: weather forecast
---
Body`,
      "weather-guide.md",
    );
    expect(parsed?.trigger?.match).toEqual(["weather forecast"]);
  });
});

describe("parseSkillFile — Cleetus capability metadata", () => {
  it("reads namespaced string metadata without changing standard skill fields", () => {
    const parsed = parseSkillFile(
      `---
name: weather-overlay
description: Project-specific weather guidance
metadata:
  cleetus-capability: Weather-Forecast
  cleetus-compose: "true"
  author: example
---
Body`,
      "weather-overlay.md",
    );

    expect(parsed).toMatchObject({
      name: "weather-overlay",
      description: "Project-specific weather guidance",
      body: "Body",
      capability: "weather-forecast",
      compose: true,
    });
  });

  it("ignores non-string and false compose extensions", () => {
    const numeric = parseSkillFile(
      "---\nname: x\nmetadata:\n  cleetus-capability: 7\n  cleetus-compose: true\n---\nbody",
      "x.md",
    );
    const falseString = parseSkillFile(
      '---\nname: y\nmetadata:\n  cleetus-compose: "false"\n---\nbody',
      "y.md",
    );
    expect(numeric?.capability).toBeUndefined();
    expect(numeric?.compose).toBeUndefined();
    expect(falseString?.compose).toBeUndefined();
  });
});
