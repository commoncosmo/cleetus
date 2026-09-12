import type { Message } from "../providers/types";

/** Convert a restored conversation snapshot into the ACP `update` objects replayed on
 *  `session/load`. Only user and assistant prose is replayed (tool/system messages are internal).
 *  messageIds are positional and stable for a given snapshot. */
export function historyToUpdates(messages: Message[]): object[] {
  const updates: object[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") {
      updates.push({
        sessionUpdate: "user_message_chunk",
        messageId: `m${i}`,
        content: { type: "text", text: m.content },
      });
    } else if (m.role === "assistant" && m.content.trim() !== "") {
      updates.push({
        sessionUpdate: "agent_message_chunk",
        messageId: `m${i}`,
        content: { type: "text", text: m.content },
      });
    }
  });
  return updates;
}
