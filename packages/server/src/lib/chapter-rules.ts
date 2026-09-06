// The structure modal imports this from the browser: keep it free of server-only imports
export const PREFACE_MIN_WORDS = 50;
const LABEL_MAX_WORDS = 120;
const OVERSIZED_MIN_WORDS = 6000;
const OVERSIZED_MEDIAN_FACTOR = 3;

// Measured against the other chapters, so a swallowed book of two chapters still shows
export function oversizedIndices(words: number[]): Set<number> {
  const flagged = new Set<number>();
  if (words.length < 2) return flagged;
  for (const [i, w] of words.entries()) {
    const others = words.filter((_, j) => j !== i).sort((a, b) => a - b);
    const median = others[Math.floor(others.length / 2)] ?? 0;
    if (w > Math.max(OVERSIZED_MEDIAN_FACTOR * median, OVERSIZED_MIN_WORDS)) flagged.add(i);
  }
  return flagged;
}

export function isLabelSized(words: number, index: number, count: number): boolean {
  return words < LABEL_MAX_WORDS && index < count - 1;
}
