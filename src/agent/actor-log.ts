import type { Actor, Event, EventInput, EventSink } from "../events/types";

/**
 * Wrap an EventSink so every appended event carries `actor` in its (object) payload.
 * Used to tag orchestrator and worker emissions without the runtime knowing about actors.
 */
export function stampActor(sink: EventSink, actor: Actor): EventSink {
  return {
    append(input: EventInput): Event {
      // `actor` is a reserved payload key: always overwrite. Guard against array payloads
      // (typeof [] === "object") which spread would mangle — cleetus payloads are plain objects.
      const isObj =
        input.payload && typeof input.payload === "object" && !Array.isArray(input.payload);
      const payload = isObj ? { ...(input.payload as Record<string, unknown>), actor } : { actor };
      return sink.append({ ...input, payload });
    },
  };
}
