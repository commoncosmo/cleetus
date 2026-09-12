import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisePlaybook, savePlaybook } from "../../src/learn/persist";
import type { PlaybookDraft } from "../../src/learn/types";

const draft: PlaybookDraft = {
  name: "weather-retrieval",
  description: "Retrieve a weather forecast.",
  triggers: ["weather", "forecast"],
  body: "## When to use\nWeather requests.\n\n## Procedure\nFetch it.\n\n## Avoid\nGuessing.\n\n## Success checks\nVerify the response.",
  source: {
    sessionId: "s1",
    startTs: 1_000,
    endTs: 2_000,
    userInput: "get the weather",
  },
};

describe("savePlaybook", () => {
  it("writes an auditable project skill that parses with its trigger", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-"));
    const saved = await savePlaybook(draft, {
      scope: "project",
      projectDir: root,
      globalDir: join(root, "global"),
      now: 3_000,
    });

    expect(saved.path).toBe(join(root, ".cleetus", "skills", "weather-retrieval.md"));
    expect(saved.skill.source).toBe("project");
    expect(saved.skill.trigger?.match).toEqual(["weather", "forecast"]);
    const text = readFileSync(saved.path, "utf8");
    expect(text).toContain("source_session: s1");
    expect(text).toContain("## Procedure");
  });

  it("refuses to overwrite an existing playbook file", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-"));
    const opts = {
      scope: "global" as const,
      projectDir: root,
      globalDir: join(root, "global"),
      now: 3_000,
    };
    await savePlaybook(draft, opts);
    expect(savePlaybook(draft, opts)).rejects.toThrow("nothing was overwritten");
  });

  it("backs up and atomically revises an unchanged learned playbook", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-"));
    const created = await savePlaybook(draft, {
      scope: "global",
      projectDir: root,
      globalDir: join(root, "global"),
      now: 3_000,
    });
    const reviewedContent = readFileSync(created.path, "utf8");
    const revision = {
      ...draft,
      body: draft.body.replace("Fetch it.", "Fetch candidates and verify the requested region."),
      source: { ...draft.source, sessionId: "s2", startTs: 4_000 },
    };

    const saved = await revisePlaybook(
      revision,
      {
        skill: {
          ...created.skill,
          scope: "execute",
          capability: "weather-forecast",
          compose: true,
          trigger: { when: ["coding-task"], match: created.skill.trigger?.match ?? [] },
        },
        path: created.path,
        reviewedContent,
      },
      { now: 5_000 },
    );

    expect(saved.backupPath).toBe(`${created.path}.bak-5000`);
    expect(existsSync(saved.backupPath!)).toBe(true);
    expect(readFileSync(saved.backupPath!, "utf8")).toBe(reviewedContent);
    const updated = readFileSync(saved.path, "utf8");
    expect(updated).toContain("verify the requested region");
    expect(updated).toContain("revision: 2");
    expect(updated).toContain("scope: execute");
    expect(updated).toContain("cleetus-capability: weather-forecast");
    expect(updated).toContain('cleetus-compose: "true"');
    expect(updated).toContain("when:");
    expect(updated).toContain("coding-task");
    expect(updated).toContain("- s1");
    expect(updated).toContain("- s2");
    expect(saved.skill.learned?.revision).toBe(2);
    expect(saved.skill.capability).toBe("weather-forecast");
    expect(saved.skill.compose).toBe(true);
  });

  it("refuses a revision when the reviewed file changed on disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleetus-learn-"));
    const created = await savePlaybook(draft, {
      scope: "project",
      projectDir: root,
      globalDir: join(root, "global"),
      now: 3_000,
    });
    const reviewedContent = readFileSync(created.path, "utf8");
    writeFileSync(created.path, `${reviewedContent}\nmanual edit\n`);

    await expect(
      revisePlaybook(
        { ...draft, body: `${draft.body}\nImproved.` },
        { skill: created.skill, path: created.path, reviewedContent },
        { now: 5_000 },
      ),
    ).rejects.toThrow("changed on disk");
    expect(existsSync(`${created.path}.bak-5000`)).toBe(false);
  });
});
