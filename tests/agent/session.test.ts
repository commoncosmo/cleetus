import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/agent/session";

let dir: string;
let db: Database;
let store: SessionStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-sess-"));
  db = new Database(join(dir, "sessions.db"));
  store = new SessionStore(db);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("creates a session with id and createdAt", () => {
    const s = store.create({ provider: "lm", model: "m1" });
    expect(s.id).toBeTruthy();
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.provider).toBe("lm");
    expect(s.model).toBe("m1");
  });

  it("loads by id", () => {
    const created = store.create({ provider: "lm", model: "m1" });
    const loaded = store.get(created.id);
    expect(loaded?.id).toBe(created.id);
  });

  it("lists most-recent first", async () => {
    const a = store.create({ provider: "lm", model: "m1" });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create({ provider: "lm", model: "m1" });
    const list = store.list();
    expect(list[0]!.id).toBe(b.id);
    expect(list[1]!.id).toBe(a.id);
  });

  it("updates provider and model after a model switch", () => {
    const s = store.create({ provider: "lm", model: "gemma" });
    store.updateModel(s.id, "ollama", "gpt-oss:120b");
    const loaded = store.get(s.id);
    expect(loaded?.provider).toBe("ollama");
    expect(loaded?.model).toBe("gpt-oss:120b");
  });

  it("updateModel on an unknown id is a no-op (does not throw)", () => {
    expect(() => store.updateModel("nope", "lm", "m2")).not.toThrow();
  });

  it("uses a supplied id when given", () => {
    const s = store.create({ id: "fixed-id-123", provider: "lm", model: "m1" });
    expect(s.id).toBe("fixed-id-123");
    expect(store.get("fixed-id-123")?.id).toBe("fixed-id-123");
  });

  it("generates a distinct id when none is supplied", () => {
    const a = store.create({ provider: "lm", model: "m1" });
    const b = store.create({ provider: "lm", model: "m1" });
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });
});
