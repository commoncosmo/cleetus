export function parseEditorWords(value: string, label: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of value) {
    if (escaping) {
      word += character;
      started = true;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += character;
    started = true;
  }

  if (escaping) throw new Error(`${label} ends with an incomplete escape`);
  if (quote) throw new Error(`${label} contains an unterminated ${quote} quote`);
  if (started) words.push(word);
  return words;
}
