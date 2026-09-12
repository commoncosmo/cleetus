import { describe, expect, it } from "bun:test";
import { historyToUpdates } from "../../src/acp/load-replay";
import type { Message } from "../../src/providers/types";

describe("historyToUpdates", () => {
  it("emits a user_message_chunk then agent_message_chunk with messageIds", () => {
    const updates = historyToUpdates([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ] as Message[]);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hi" },
    });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
    expect((updates[0] as { messageId: string }).messageId).toBeTruthy();
  });

  it("skips tool and system messages (only user/assistant prose is replayed)", () => {
    const updates = historyToUpdates([
      { role: "system", content: "sys" },
      { role: "tool", content: "result", toolCallId: "t1" },
      { role: "assistant", content: "ok" },
    ] as Message[]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ sessionUpdate: "agent_message_chunk" });
  });
});
