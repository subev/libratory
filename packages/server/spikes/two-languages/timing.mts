// Character offset → milliseconds on one narrated lane, one edge at a time, each edge saying how it
// was obtained. Offsets are UTF-16 code units into the lane's stored text.
import { locateChunks } from "../../src/lib/chunk-previews.ts";
import type { SyncMap } from "../../src/lib/sync-map.ts";
import type { Span } from "./segment.mts";

// provider-word: the engine's own word timestamp. chunk-boundary: a chunk's start or end, which
// includes any silence the engine left there. interpolated: by non-space characters between known
// points inside one located chunk. unavailable: the text could not be located in the audio.
export type EdgeMethod = "provider-word" | "chunk-boundary" | "interpolated" | "unavailable";
export type Edge = { ms: number | null; method: EdgeMethod };
export type SpanTiming = { start: Edge; end: Edge };

type TimedWord = Span & { startMs: number; endMs: number };
type Chunk = Span & { startMs: number; endMs: number; words: TimedWord[] };
export type Timeline = { text: string; chunks: Chunk[]; words: TimedWord[]; weight: Int32Array };

const MEANINGFUL = /[\p{L}\p{N}]/u;

export function timeline(text: string, map: SyncMap): Timeline {
  const chunks: Chunk[] = [];
  for (const [i, range] of locateChunks(text, map.chunks.map((c) => c.text)).entries()) {
    const chunk = map.chunks[i];
    if (!range || !chunk) continue;
    chunks.push({ ...range, startMs: chunk.startMs, endMs: chunk.endMs, words: locateWords(text, range, chunk.words ?? []) });
  }
  const weight = new Int32Array(text.length + 1);
  for (let c = 0; c < text.length; c++) weight[c + 1] = weight[c]! + (/\s/.test(text[c]!) ? 0 : 1);
  return { text, chunks, words: chunks.flatMap((c) => c.words), weight };
}

// Engines report words as they spoke them; each is found in order, a short way past the last
function locateWords(text: string, range: Span, reported: { text: string; startMs: number; endMs: number }[]): TimedWord[] {
  const out: TimedWord[] = [];
  let cursor = range.start;
  for (const w of reported) {
    const needle = w.text.trim();
    const at = needle ? text.indexOf(needle, cursor) : -1;
    if (at === -1 || at > cursor + 40 || at + needle.length > range.end) continue;
    out.push({ start: at, end: at + needle.length, startMs: w.startMs, endMs: w.endMs });
    cursor = at + needle.length;
  }
  return out;
}

export function spanTiming(tl: Timeline, span: Span): SpanTiming {
  return { start: startEdge(tl, span.start), end: endEdge(tl, span.end) };
}

// Nothing but punctuation and spaces between two offsets
function silentBetween(text: string, from: number, to: number): boolean {
  return from <= to && !MEANINGFUL.test(text.slice(from, to));
}

function startEdge(tl: Timeline, at: number): Edge {
  const chunk = tl.chunks.find((c) => c.start <= at && at < c.end) ?? tl.chunks.find((c) => c.start >= at && silentBetween(tl.text, at, c.start));
  if (!chunk) return { ms: null, method: "unavailable" };
  const word = chunk.words.find((w) => w.end > at && silentBetween(tl.text, at, Math.max(at, w.start)));
  if (word) return { ms: word.startMs, method: "provider-word" };
  if (silentBetween(tl.text, chunk.start, at)) return { ms: chunk.startMs, method: "chunk-boundary" };
  return { ms: interpolate(tl, chunk, at), method: "interpolated" };
}

function endEdge(tl: Timeline, at: number): Edge {
  const chunk = tl.chunks.find((c) => c.start < at && at <= c.end) ?? tl.chunks.findLast((c) => c.end <= at && silentBetween(tl.text, c.end, at));
  if (!chunk) return { ms: null, method: "unavailable" };
  const word = chunk.words.findLast((w) => w.start < at && silentBetween(tl.text, Math.min(at, w.end), at));
  if (word) return { ms: word.endMs, method: "provider-word" };
  if (silentBetween(tl.text, at, chunk.end)) return { ms: chunk.endMs, method: "chunk-boundary" };
  return { ms: interpolate(tl, chunk, at), method: "interpolated" };
}

// Linear by non-space characters between the nearest known points of the same chunk — never across
// a chunk the audio could not be matched to
function interpolate(tl: Timeline, chunk: Chunk, at: number): number {
  const points = [{ at: chunk.start, ms: chunk.startMs }, ...chunk.words.flatMap((w) => [{ at: w.start, ms: w.startMs }, { at: w.end, ms: w.endMs }]), { at: chunk.end, ms: chunk.endMs }];
  const before = points.findLast((p) => p.at <= at) ?? points[0]!;
  const after = points.find((p) => p.at >= at) ?? points.at(-1)!;
  const span = tl.weight[after.at]! - tl.weight[before.at]!;
  if (span <= 0) return before.ms;
  return Math.round(before.ms + ((after.ms - before.ms) * (tl.weight[at]! - tl.weight[before.at]!)) / span);
}
