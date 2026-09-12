import type { Event } from "../../events/types";

/** Braille spinner cycle, one glyph per SPINNER_MS. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_MS = 80;
export const WORD_MS = 6000;
export const COLOR_MS = 400;

/** Glyph colors, cycled on the COLOR_MS beat. Ink color names. */
export const PALETTE = ["cyan", "green", "yellow", "magenta", "blue"];

/**
 * Thinking-phase activity words. One is chosen at random each rotation. The list
 * is weighted toward mild backwoods flavor (39 mild) with salty ones (16) mixed
 * in, so a random pick lands tame most of the time.
 */
export const THINKING_WORDS = [
  // mild
  "cipherin'…",
  "chewin' on it…",
  "wranglin' them bits…",
  "cookin' somethin' up…",
  "rootin' around…",
  "fixin' to figure it…",
  "noodlin' on it…",
  "moseyin' through it…",
  "whittlin' away…",
  "studyin' on it…",
  "hollerin' at the model…",
  "ponderin' real hard…",
  "scratchin' my head…",
  "muddlin' through…",
  "figgerin' it out…",
  "tinkerin' with it…",
  "churnin' butter…",
  "spinnin' my wheels…",
  "rustlin' up an answer…",
  "loadin' the wagon…",
  "greasin' the gears…",
  "shuckin' corn…",
  "mendin' the fence…",
  "sortin' the hogs…",
  "balin' hay…",
  "fishin' for it…",
  "huntin' a notion…",
  "stewin' on it…",
  "percolatin'…",
  "crankin' the engine…",
  "diggin' a trench…",
  "splittin' firewood…",
  "feedin' the chickens…",
  "saddlin' up…",
  "whittlin' a plan…",
  "hammerin' it out…",
  "plowin' the back forty…",
  "countin' my chickens…",
  "fixin' to fix it…",
  "ennerin' that there thunderdome…",
  "what if c-a-t really spelled dog, know what I mean?…",
  "filosifizin' on it…",
  "heavy blaspheming…",
  "readin', ritin', and rifmatikin'…",
  "bless this model's little heart…",
  "mullet time y'all!…",
  "well shoot Dave, now I just don't think I'm gonna be able to do that…",
  "wait, did y'all say mullet time or miller time?  I'm good either way… just checkin'…",
  // salty
  "gittin' 'er done…",
  "raisin' hell…",
  "givin' 'er the beans…",
  "bustin' my ass on it…",
  "workin' my ass off…",
  "raisin' a ruckus…",
  "kickin' ass an' takin' names…",
  "haulin' ass…",
  "bustin' a gut…",
  "givin' 'er hell…",
  "sweatin' like a sinner in church…",
  "fixin' to open up some whoopass…",
  "I'ma open up some whoopass on that model…",
  "yankin' my crank…",
  "tellin' that model to squeal like a pig…",
  "eyein' that waffle house waitress…",
  "dealin' with this model is like tryin to enjoy a poopy flavored lollipop y'all…",
  "wtf ever happen to shoney's?  That buffet was bangin…",
  "I aint kickin that out a bed for eatin' crackers…",
  "now you just hold on… I'm butterin' these buns… be back in a jiffy…",
  "I'll betcha a pair of truck nuts this is a bad idea…",
  "well now just slap my ass and call me Sally!…",
  "Guess I'll be a fixin things cuz you keep rekon em…",
  "BOHICA Y'all!…",
];

/** Tool name → backwoods phrase. Unmapped tools use a fallback. */
export const TOOL_PHRASES: Record<string, string> = {
  bash: "fixin' to run some shell…",
  read_file: "rootin' through a file…",
  write_file: "scribblin' to disk…",
  edit_file: "patchin' 'er up…",
  grep: "diggin' through the haystack…",
  glob: "huntin' for files…",
};

export type BusyPhase =
  | { kind: "thinking" }
  | { kind: "tool"; tool: string }
  | { kind: "workflow"; text: string }
  | { kind: "compaction" };

function workflowActivity(payload: unknown): string | null {
  const p = payload as {
    activity?: string;
    kind?: string;
    workflow?: string;
    phase?: string;
    workflowEvent?: {
      type?: string;
      workflow?: string;
      stepId?: string;
      ordinal?: number;
      totalSteps?: number;
      uses?: string;
      status?: string;
      attempt?: number;
    };
  };
  if (p.activity === "creator") {
    if (p.phase === "generating" || p.kind === "workflow_creator_started") {
      return `drafting ${p.workflow ?? "workflow"}…`;
    }
    return null;
  }
  const event = p.workflowEvent;
  if (!event) return null;
  if (event.type === "step_status" && event.status === "running") {
    const position =
      event.ordinal && event.totalSteps ? `step ${event.ordinal} of ${event.totalSteps}` : "step";
    const attempt = event.attempt && event.attempt > 1 ? ` · attempt ${event.attempt}` : "";
    return `${event.workflow ?? "workflow"} · ${position} · ${event.stepId ?? event.uses ?? "running"}${attempt}…`;
  }
  if (event.type === "run_status") {
    if (event.status === "preparing") return `preparing ${event.workflow ?? "workflow"}…`;
    if (event.status === "awaiting_permission") {
      return `${event.workflow ?? "workflow"} · waiting for permission…`;
    }
    if (event.status === "running") return `running ${event.workflow ?? "workflow"}…`;
  }
  return null;
}

/**
 * Decide what the agent is doing from the event stream. A `tool_call_start`
 * marks a tool in flight; the matching `tool_call_end` clears it. A
 * `compaction_start` marks an active compaction; `compaction_end` clears it.
 * Compaction takes precedence and is returned as `{ kind: "compaction" }`;
 * otherwise the last pending tool wins, or we're thinking.
 */
export function derivePhase(events: Event[]): BusyPhase {
  let pending: string | null = null;
  let compacting = false;
  let workflow: string | null = null;
  for (const e of events) {
    if (e.type === "tool_call_start") {
      pending = (e.payload as { call: { name: string } }).call.name;
    } else if (e.type === "tool_call_end") {
      pending = null;
    } else if (e.type === "compaction_start") {
      compacting = true;
    } else if (e.type === "compaction_end") {
      compacting = false;
    } else if (e.type === "workflow_status") {
      workflow = workflowActivity(e.payload);
    } else if (e.type === "workflow_result") {
      workflow = null;
    }
  }
  if (compacting) return { kind: "compaction" };
  if (workflow) return { kind: "workflow", text: workflow };
  return pending ? { kind: "tool", tool: pending } : { kind: "thinking" };
}

/**
 * Activity text for a phase. Tool phase uses the mapped phrase; thinking phase
 * picks a word at random (`rand` in [0, 1), defaulting to Math.random()).
 */
export function pickBusyText(phase: BusyPhase, rand: number = Math.random()): string {
  if (phase.kind === "workflow") return phase.text;
  if (phase.kind === "tool") {
    return TOOL_PHRASES[phase.tool] ?? `fixin' to ${phase.tool}…`;
  }
  return THINKING_WORDS[Math.floor(rand * THINKING_WORDS.length)]!;
}

/** Spinner glyph for an elapsed time. */
export function pickFrame(elapsedMs: number): string {
  return SPINNER_FRAMES[Math.floor(elapsedMs / SPINNER_MS) % SPINNER_FRAMES.length]!;
}

/** Glyph color for an elapsed time. */
export function pickColor(elapsedMs: number): string {
  return PALETTE[Math.floor(elapsedMs / COLOR_MS) % PALETTE.length]!;
}
