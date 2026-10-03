// Word tokens of a sentence, numbered from 1, with their ranges in the stored text. Intl.Segmenter's
// word granularity does the work (dictionary-based for unspaced scripts); the output is persisted
// with the links so a later tokenizer can never re-interpret stored ids.
import type { Span } from "./segment.mts";

export type Token = Span & { id: number };

export const TOKENIZER = "intl-segmenter-word/1";

export function tokenize(text: string, sentence: Span, locale: string): Token[] {
  const tokens: Token[] = [];
  for (const w of new Intl.Segmenter(locale, { granularity: "word" }).segment(text.slice(sentence.start, sentence.end))) {
    if (!w.isWordLike) continue;
    tokens.push({ id: tokens.length + 1, start: sentence.start + w.index, end: sentence.start + w.index + w.segment.length });
  }
  return tokens;
}
