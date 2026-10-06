// A chunk never crosses a blank line, and within a paragraph a piece shorter than `minChars` joins
// its neighbour while the two fit in `maxChars`. Every chunk is one request and one preview file,
// and every seam between chunks restarts the voice — so where the seams fall is a prosody choice.
export type ChunkLimits = { maxChars: number; minChars: number };

// A sentence per chunk, which is also the sync map's highlight unit for engines with no word timings
export const SENTENCE_CHUNKS: ChunkLimits = { maxChars: 240, minChars: 40 };

// The cloud voices time every word themselves, so a chunk need not be a sentence. A whole paragraph
// up to this size is one request and reads as one breath; the cap bounds what a failed request
// costs to redo, well under every provider's request limit.
export const PARAGRAPH_CHUNKS: ChunkLimits = { maxChars: 1000, minChars: 1000 };

export function chunkTextForTts(text: string, limits: ChunkLimits): string[] {
  // A blank line ends a chunk: a title without a full stop would otherwise run straight into the
  // sentence after it, with no pause, because nothing in the text tells the voice it has ended.
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    // A scene break ("* * *", "—") has nothing to say, and a chunk with nothing to say fails the
    // engines that refuse to return silence
    .filter((paragraph) => /[\p{L}\p{N}]/u.test(paragraph))
    .flatMap((paragraph) => mergeShortUnits(toUnits(paragraph, limits.maxChars), limits));
}

function mergeShortUnits(units: string[], limits: ChunkLimits): string[] {
  const chunks: string[] = [];

  for (const unit of units) {
    const prev = chunks.at(-1);
    const eitherIsShort = prev !== undefined && (prev.length < limits.minChars || unit.length < limits.minChars);
    if (prev !== undefined && eitherIsShort && prev.length + 1 + unit.length <= limits.maxChars) {
      chunks[chunks.length - 1] = `${prev} ${unit}`;
    } else {
      chunks.push(unit);
    }
  }

  return chunks;
}

// Split into the smallest natural units we won't break further: whole sentences, or — for a single
// sentence longer than the cap — word-level pieces that each fit.
function toUnits(text: string, maxChars: number): string[] {
  const units: string[] = [];
  for (const sentence of splitIntoSentences(text)) {
    if (sentence.length <= maxChars) {
      units.push(sentence);
    } else {
      units.push(...splitByWords(sentence, maxChars));
    }
  }
  return units;
}

function splitIntoSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+(?:[.!?]+|$)/gu);
  if (!matches) return [text];
  return matches.map((part) => part.trim()).filter(Boolean);
}

function splitByWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = word; // a single word longer than the cap is kept whole (rare)
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
