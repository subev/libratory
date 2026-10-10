import path from "node:path";
import type { ReaderCue, ReaderCues, ReaderManifest } from "./reader-format.ts";
import type { SyncMap, SyncWord } from "./sync-map.ts";

// The pure half of bringing a read-along export back: what its cue documents say, turned into
// the sync maps and chapter text the app keeps beside its own audio. Everything here is a
// function of the file's contents; lib/synced-epub-books.ts does the unzipping and the rows.

// A cue document names its resources relative to book.json, inside the zip
export function layerEntryPath(bookJsonEntry: string, relative: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(bookJsonEntry), relative));
}

function wordsOf(cues: ReaderCue[]): SyncWord[] | undefined {
  const timed = cues.map((cue) => cue.w).filter((w): w is NonNullable<ReaderCue["w"]> => w !== undefined);
  if (timed.length !== cues.length) return undefined;
  const words = timed.flat().map(([startMs, endMs, text]) => ({ text, after: " ", startMs, endMs }));
  const last = words[words.length - 1];
  if (last) last.after = "";
  return words;
}

// Cues are cut from synthesis chunks and say which (`c`); grouping them back gives the chunks a
// sync map is made of, with word timings where every cue of the chunk carried them
export function syncMapFromCues(doc: ReaderCues): SyncMap {
  const byChunk = new Map<number, ReaderCue[]>();
  for (const cue of doc.cues) {
    const list = byChunk.get(cue.c) ?? [];
    list.push(cue);
    byChunk.set(cue.c, list);
  }
  const chunks = [...byChunk.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, cues]) => {
      const words = wordsOf(cues);
      return {
        text: cues.map((cue) => cue.s).join(" "),
        startMs: Math.min(...cues.map((cue) => cue.t[0])),
        endMs: Math.max(...cues.map((cue) => cue.t[1])),
        ...(words ? { words } : {}),
      };
    });
  return { version: 2, totalMs: doc.totalMs, chunks };
}

// Concatenated in order, the cues are the chapter's text; a cue document that carries the text
// itself is taken as written
export function chapterTextFromCues(doc: ReaderCues): string {
  if (doc.text?.text) return doc.text.text;
  return syncMapFromCues(doc).chunks.map((chunk) => chunk.text).join("\n");
}

// What the file is on the shelf: a bilingual export names its translation on its chapters
export function documentFormatOf(manifest: ReaderManifest): { format: "epub-sync" | "epub-bilingual"; language: string | null } {
  const paired = manifest.chapters.flatMap((chapter) => chapter.bilingual ?? []);
  const first = paired[0];
  return first ? { format: "epub-bilingual", language: first.key } : { format: "epub-sync", language: null };
}

function isTime(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

// The parts of a cue document the import reads; anything else in it is a reader's business
export function isReaderCues(value: unknown): value is ReaderCues {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { totalMs?: unknown; cues?: unknown };
  if (typeof v.totalMs !== "number" || !Array.isArray(v.cues)) return false;
  return v.cues.every((cue: unknown) => {
    if (typeof cue !== "object" || cue === null) return false;
    const c = cue as { t?: unknown; s?: unknown; c?: unknown; w?: unknown };
    const wordsOk = c.w === undefined || (Array.isArray(c.w) && c.w.every((w: unknown) => Array.isArray(w) && w.length === 3 && typeof w[0] === "number" && typeof w[1] === "number" && typeof w[2] === "string"));
    return isTime(c.t) && typeof c.s === "string" && typeof c.c === "number" && wordsOk;
  });
}

export function isReaderManifest(value: unknown): value is ReaderManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { format?: unknown; book?: unknown; chapters?: unknown };
  if (typeof v.format !== "string" || !v.format.startsWith("p2af/") || typeof v.book !== "object" || v.book === null || !Array.isArray(v.chapters)) return false;
  const description = (v.book as { description?: unknown }).description;
  return description === undefined || description === null || typeof description === "string";
}
