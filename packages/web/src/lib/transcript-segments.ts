import type { ReaderCue } from "./reader-doc.ts";

export function transcriptSegments(start: number, end: number, cues: ReaderCue[]) {
  const segments: { start: number; end: number; cue: number | null }[] = [];
  let cursor = start;
  for (const [i, cue] of cues.entries()) {
    if (!cue.range || cue.range[1] <= cursor || cue.range[0] >= end) continue;
    const from = Math.max(cursor, cue.range[0]);
    if (from > cursor) segments.push({ start: cursor, end: from, cue: null });
    cursor = Math.min(end, cue.range[1]);
    segments.push({ start: from, end: cursor, cue: i });
  }
  if (cursor < end) segments.push({ start: cursor, end, cue: null });
  return segments;
}

export function transcriptWordRange(text: string, cue: ReaderCue | undefined, word: number) {
  if (!cue?.range || word < 0) return null;
  let cursor = cue.range[0];
  for (let i = 0; i <= word; i++) {
    const value = cue.w?.[i]?.[2];
    if (!value) return null;
    const at = text.indexOf(value, cursor);
    if (at < cursor || at + value.length > cue.range[1]) return null;
    cursor = at + value.length;
    if (i === word) return { start: at, end: cursor };
  }
  return null;
}
