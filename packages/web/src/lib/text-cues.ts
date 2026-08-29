import { cueIndexAt, wordIndexAt, type ReaderCue, type ReaderCues } from "./reader-doc.ts";

export type TextSpan = { start: number; end: number };
export type TextMark = TextSpan & { word: TextSpan | null };

function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch && !/\s/.test(ch)) {
      norm += ch;
      map.push(i);
    }
  }
  return { norm, map };
}

// Whitespace-insensitive, the way the server locates chunk texts (`locateChunks`): the chunker
// collapses runs and adds spaces at sentence joins, so only the non-whitespace characters are
// reliable. A cursor keeps repeated sentences on sequential spans, and a sentence the text no
// longer has is null — unmarked beats marking the wrong words.
export function locateSpans(text: string, needles: string[]): (TextSpan | null)[] {
  const { norm, map } = normalizeWithMap(text);
  let cursor = 0;

  return needles.map((needle) => {
    const compact = needle.replace(/\s+/g, "");
    if (!compact) return null;

    const at = norm.indexOf(compact, cursor);
    if (at === -1) return null;

    cursor = at + compact.length;
    const start = map[at];
    const end = map[at + compact.length - 1];
    if (start === undefined || end === undefined) return null;
    return { start, end: end + 1 };
  });
}

// The sentence being spoken, where it sits in the text on the page, and the word inside it.
// Both are absolute offsets: a sentence can be split across chunks, and a word searched for
// again in each half lands on whichever half happens to repeat it.
export function cueMark(text: string, spans: (TextSpan | null)[], cues: ReaderCues | null, ms: number): TextMark | null {
  if (!cues) return null;
  const index = cueIndexAt(cues.cues, ms);
  const cue = index >= 0 ? cues.cues[index] : undefined;
  const span = spans[index];
  if (!cue || !span) return null;
  return { ...span, word: wordSpan(text, span, cue, wordIndexAt(cue, ms)) };
}

// Walking the earlier words keeps a repeated word on the one being spoken, and matching the
// sentence as written rather than re-joining the words keeps the spacing the book has.
function wordSpan(text: string, span: TextSpan, cue: ReaderCue, word: number): TextSpan | null {
  const spoken = word >= 0 ? cue.w?.[word]?.[2] : undefined;
  if (!spoken) return null;

  const sentence = text.slice(span.start, span.end);
  let cursor = 0;
  for (let i = 0; i < word; i++) {
    const before = cue.w?.[i]?.[2];
    if (before === undefined) continue;
    const at = sentence.indexOf(before, cursor);
    if (at >= 0) cursor = at + before.length;
  }
  const start = sentence.indexOf(spoken, cursor);
  if (start < 0) return null;
  return { start: span.start + start, end: span.start + start + spoken.length };
}
