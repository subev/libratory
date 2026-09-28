// Sentences as character ranges into the text they came from, so a pair survives any rendering.
// Nothing here knows a language: Intl.Segmenter does the splitting, two Unicode-class rules correct
// it, and whatever it still gets wrong (an abbreviation ending a "sentence") is absorbed by the
// aligner, which groups up to four sentences on either side of a pair.
export type Span = { start: number; end: number };

// Intl.Segmenter keeps a run of dash or quote dialogue as one sentence ("– he said. – Thanks")
const DIALOGUE_BREAK = /(?<=\p{Sentence_Terminal}[\p{Pf}\p{Pe}"']?)\s+(?=[\p{Pd}\p{Pi}\p{Ps}"])/gu;
const TERMINAL = /\p{Sentence_Terminal}[\p{Pf}\p{Pe}"']*$/u;

export function sentences(text: string, locale: string): Span[] {
  const out: Span[] = [];
  for (const s of new Intl.Segmenter(locale, { granularity: "sentence" }).segment(text)) {
    let from = 0;
    const pieces = [...s.segment.matchAll(DIALOGUE_BREAK)].map((m) => {
      const piece = { start: s.index + from, end: s.index + (m.index ?? 0) };
      from = (m.index ?? 0) + m[0].length;
      return piece;
    });
    pieces.push({ start: s.index + from, end: s.index + s.segment.length });

    for (const piece of pieces) {
      const span = trim(text, piece);
      if (!span) continue;
      const prev = out.at(-1);
      // An extracted PDF breaks paragraphs mid-sentence ("…side. The⏎⏎goose boy said"): no
      // terminal mark before and a lowercase letter after is one sentence. Caseless scripts never match.
      if (prev && !TERMINAL.test(text.slice(prev.start, prev.end)) && /^\p{Ll}/u.test(text.slice(span.start))) prev.end = span.end;
      else out.push(span);
    }
  }
  return out;
}

function trim(text: string, span: Span): Span | null {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start] ?? "")) start++;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
  return end > start ? { start, end } : null;
}

// Word tokens of a sentence, numbered from 1, with their ranges in the stored text. Intl.Segmenter's
// word granularity does the work (dictionary-based for unspaced scripts); the output is persisted
// with the links so a later tokenizer can never re-interpret stored ids.

export type Token = Span & { id: number };

export function tokenize(text: string, sentence: Span, locale: string): Token[] {
  const tokens: Token[] = [];
  for (const w of new Intl.Segmenter(locale, { granularity: "word" }).segment(text.slice(sentence.start, sentence.end))) {
    if (!w.isWordLike) continue;
    tokens.push({ id: tokens.length + 1, start: sentence.start + w.index, end: sentence.start + w.index + w.segment.length });
  }
  return tokens;
}
