// Learned skills auto-invoke through deterministic substring matching. One distinctive domain
// noun keeps that useful across ordinary rephrasing; generic work/output words are too broad.
const GENERIC_ANCHOR_WORDS = new Set([
  "add",
  "app",
  "build",
  "change",
  "check",
  "code",
  "create",
  "current",
  "data",
  "edit",
  "fetch",
  "file",
  "files",
  "find",
  "fix",
  "help",
  "implement",
  "issue",
  "look",
  "looking",
  "make",
  "modify",
  "new",
  "output",
  "please",
  "project",
  "request",
  "result",
  "results",
  "run",
  "save",
  "show",
  "summarize",
  "summary",
  "test",
  "tests",
  "three",
  "tool",
  "update",
  "use",
  "using",
  "write",
]);

function contentWords(value: string): string[] {
  return (
    value
      .toLowerCase()
      .replace(/-/g, " ")
      .match(/[a-z0-9]{3,}/g) ?? []
  );
}

export function hasLearnedIntentAnchor(opts: {
  triggers: string[];
  name: string;
  description: string;
  userInput?: string;
}): boolean {
  const inputWords = opts.userInput ? new Set(contentWords(opts.userInput)) : undefined;
  const identityWords = new Set(contentWords(`${opts.name} ${opts.description}`));
  return opts.triggers.some((trigger) => {
    const word = trigger.toLowerCase();
    return (
      !/\s/.test(trigger) &&
      identityWords.has(word) &&
      (inputWords?.has(word) ?? true) &&
      !GENERIC_ANCHOR_WORDS.has(word)
    );
  });
}

/**
 * Put one short, distinctive intent anchor first. New drafts additionally ground the anchor in
 * `userInput`; loading an older learned playbook omits that argument and derives from its stable
 * name, description, and existing literal phrases.
 */
export function withLearnedIntentAnchor(opts: {
  triggers: string[];
  name: string;
  description: string;
  userInput?: string;
}): string[] {
  const inputWords = opts.userInput ? new Set(contentWords(opts.userInput)) : undefined;
  const identityWords = new Set(contentWords(`${opts.name} ${opts.description}`));
  const eligible = (word: string) =>
    identityWords.has(word) && (inputWords?.has(word) ?? true) && !GENERIC_ANCHOR_WORDS.has(word);

  const explicit = opts.triggers.find(
    (trigger) => !/\s/.test(trigger) && eligible(trigger.toLowerCase()),
  );
  if (explicit) {
    return [explicit, ...opts.triggers.filter((trigger) => trigger !== explicit)].slice(0, 6);
  }

  const counts = new Map<string, number>();
  for (const trigger of opts.triggers) {
    for (const word of new Set(contentWords(trigger))) {
      if (eligible(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const anchor = [...counts.entries()]
    .sort(([left, leftCount], [right, rightCount]) => {
      if (leftCount !== rightCount) return rightCount - leftCount;
      if (left.length !== right.length) return left.length - right.length;
      return left.localeCompare(right);
    })
    .at(0)?.[0];
  if (!anchor) return opts.triggers.slice(0, 6);
  return [anchor, ...opts.triggers.filter((trigger) => trigger.toLowerCase() !== anchor)].slice(
    0,
    6,
  );
}
