import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDraftStore } from "../../../src/workflows/creator/draft-store";

describe("WorkflowDraftStore", () => {
  test("persists host-assigned draft identity and conversation state", () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const draft = store.create({ scope: "project", name: "weather" });
    draft.messages.push({ role: "user", content: "summarize weather" });
    store.save(draft);
    expect(store.get(draft.id)).toMatchObject({
      id: draft.id,
      scope: "project",
      name: "weather",
      messages: [{ role: "user", content: "summarize weather" }],
    });
    expect(() => store.get("../../escape")).toThrow("invalid workflow draft id");
  });

  test("recovers the newest unfinished draft for the same session", async () => {
    const store = new WorkflowDraftStore(mkdtempSync(join(tmpdir(), "workflow-drafts-")));
    const first = store.create({ scope: "project", name: "first", sessionId: "session-one" });
    const other = store.create({ scope: "project", name: "other", sessionId: "session-two" });
    await Bun.sleep(2);
    const latest = store.create({ scope: "global", name: "latest", sessionId: "session-one" });
    other.phase = "activated";
    store.save(other);

    expect(store.latest("session-one")).toMatchObject({
      id: latest.id,
      scope: "global",
      sessionId: "session-one",
    });
    expect(store.latest("session-two")).toBeUndefined();
    expect(store.list().map((draft) => draft.id)).toContain(first.id);
  });
});
