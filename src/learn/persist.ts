import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseSkillFile } from "../skills/parse";
import type { Skill } from "../skills/types";
import type { PlaybookDraft, PlaybookScope, SavedPlaybook } from "./types";

function learnedMetadata(draft: PlaybookDraft, now: number, existing?: Skill) {
  const sourceSessions = [
    ...(existing?.learned?.sourceSessions ?? []),
    draft.source.sessionId,
  ].filter((value, index, all) => all.indexOf(value) === index);
  return {
    source_session: draft.source.sessionId,
    source_sessions: sourceSessions,
    source_turn_started_at: new Date(draft.source.startTs).toISOString(),
    created_at: existing?.learned?.createdAt ?? new Date(now).toISOString(),
    ...(existing
      ? {
          updated_at: new Date(now).toISOString(),
          revision: (existing.learned?.revision ?? 1) + 1,
        }
      : { revision: 1 }),
  };
}

export function renderSkillFile(draft: PlaybookDraft, now: number, existing?: Skill): string {
  const frontmatter = stringifyYaml({
    name: draft.name,
    description: draft.description,
    trigger: {
      ...(existing?.trigger?.when.length ? { when: existing.trigger.when } : {}),
      match: draft.triggers,
    },
    ...(existing?.scope ? { scope: existing.scope } : {}),
    metadata: {
      ...(existing?.capability ? { "cleetus-capability": existing.capability } : {}),
      ...(existing?.compose ? { "cleetus-compose": "true" } : {}),
      learned: learnedMetadata(draft, now, existing),
    },
  }).trim();
  return `---\n${frontmatter}\n---\n\n${draft.body.trim()}\n`;
}

function savedFromContent(
  content: string,
  path: string,
  scope: PlaybookScope,
  backupPath?: string,
): SavedPlaybook {
  const parsed = parseSkillFile(content, path);
  if (!parsed) throw new Error("the saved playbook could not be parsed");
  return {
    path,
    scope,
    skill: { ...parsed, source: scope, filePath: path },
    ...(backupPath ? { backupPath } : {}),
  };
}

/** Persist one approved draft without overwriting any existing playbook file. */
export async function savePlaybook(
  draft: PlaybookDraft,
  opts: {
    scope: PlaybookScope;
    projectDir: string;
    globalDir: string;
    now?: number;
  },
): Promise<SavedPlaybook> {
  const root =
    opts.scope === "project"
      ? join(opts.projectDir, ".cleetus", "skills")
      : join(opts.globalDir, "skills");
  await mkdir(root, { recursive: true });
  const path = join(root, `${draft.name}.md`);
  const content = renderSkillFile(draft, opts.now ?? Date.now());
  const saved = savedFromContent(content, path, opts.scope);
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`a playbook file already exists at ${path}; nothing was overwritten`);
    }
    throw error;
  }
  return saved;
}

/** Atomically replace one explicitly approved Cleetus-managed playbook revision.
 *
 * The exact content reviewed by the user must still be on disk. A timestamped backup is created
 * before an atomic same-directory rename, and the live registry is updated only after success.
 */
export async function revisePlaybook(
  draft: PlaybookDraft,
  target: { skill: Skill; path: string; reviewedContent: string },
  opts: { now?: number },
): Promise<SavedPlaybook> {
  if (!target.skill.learned || target.skill.source === "built-in") {
    throw new Error("only Cleetus-managed project or global playbooks can be revised");
  }
  if (target.skill.baseDir) {
    throw new Error("directory skills cannot be revised automatically");
  }
  const current = await readFile(target.path, "utf8");
  if (current !== target.reviewedContent) {
    throw new Error(
      "the playbook changed on disk after the draft was prepared; nothing was overwritten",
    );
  }

  const now = opts.now ?? Date.now();
  const content = renderSkillFile(draft, now, target.skill);
  const backupPath = `${target.path}.bak-${now}`;
  const tempPath = join(
    dirname(target.path),
    `.${basename(target.path)}.tmp-${process.pid}-${now}`,
  );
  const saved = savedFromContent(content, target.path, target.skill.source, backupPath);
  await copyFile(target.path, backupPath, constants.COPYFILE_EXCL);
  try {
    await writeFile(tempPath, content, { flag: "wx" });
    await rename(tempPath, target.path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // No temporary file was created, or it was already renamed.
    }
    throw error;
  }
  return saved;
}
