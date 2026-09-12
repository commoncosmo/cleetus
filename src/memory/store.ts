import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BULLET = "- ";

export class MemoryStore {
  constructor(private readonly filePath: string) {}

  /** The file this store reads from and writes to. Exposed so callers (e.g. the remember tool)
   *  can report the real location instead of guessing at one. */
  get path(): string {
    return this.filePath;
  }

  private readLines(): string[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return readFileSync(this.filePath, "utf8").split("\n");
    } catch {
      return [];
    }
  }

  list(): string[] {
    return this.readLines()
      .filter((line) => line.startsWith(BULLET))
      .map((line) => line.slice(BULLET.length).trim());
  }

  add(text: string): void {
    const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
    if (!oneLine) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const existing = existsSync(this.filePath) ? readFileSync(this.filePath, "utf8") : "";
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(this.filePath, `${existing}${sep}${BULLET}${oneLine}\n`);
  }

  removeAt(index: number): boolean {
    const lines = this.readLines();
    let bulletCount = 0;
    let target = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith(BULLET)) {
        if (bulletCount === index) {
          target = i;
          break;
        }
        bulletCount++;
      }
    }
    if (target === -1) return false;
    lines.splice(target, 1);
    const body = lines.join("\n").replace(/^\n+|\n+$/g, "");
    writeFileSync(this.filePath, body ? `${body}\n` : "");
    return true;
  }
}
