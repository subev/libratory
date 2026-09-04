import { asc, eq } from "drizzle-orm";

import { db } from "../db.ts";
import { bookFiles, chapters, books, type Book, type Chapter } from "../schema.ts";
import { cuesFromSyncMap, type Cue } from "./cues.ts";
import { rectsForRange } from "./cue-rects.ts";
import { describeError } from "./errors.ts";
import { locateChunks } from "./chunk-previews.ts";
import { listMarkerSources, type MarkerSource } from "./marker-sources.ts";
import { languageCode } from "./readaloud-epub.ts";
import { ensureSourceGeometry, medianBodyPt, pageLayout, type GeometryPage } from "./page-geometry.ts";
import { readSyncMap, type SyncWord } from "./sync-map.ts";
import type { SourceBlock } from "./marker.ts";
import {
  READER_FORMAT,
  type CueRect,
  type ReaderChapter,
  type ReaderCues,
  type ReaderManifest,
  type ReaderPage,
  type ReaderText,
} from "./reader-format.ts";

// The reader reads these documents, never the database — every gap in them shows up here first
export * from "./reader-format.ts";

// Edited, synthetic, or never narrated — no rects rather than wrong ones, and the reason travels
// with the document so a reader can say which it was. The pages are unaffected: they come from the
// PDF, so a chapter that cannot be marked is still a chapter that can be read.
export function chapterMode(chapter: Chapter): Pick<ReaderChapter, "mode" | "why"> {
  if (!Array.isArray(chapter.sourceBlocks)) return { mode: "text", why: "generated" };
  if (chapter.customText) return { mode: "text", why: "edited" };
  if (!chapter.textMap) return { mode: "text", why: chapter.audioPath ? "unmapped" : "unnarrated" };
  return { mode: "page" };
}

export async function buildManifest(book: Book): Promise<ReaderManifest> {
  const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, book.id)).orderBy(asc(bookFiles.index));
  const sources = await listMarkerSources(book);

  const pages: ReaderPage[] = [];
  const geometryPages: GeometryPage[] = [];
  const sourceEntries: ReaderManifest["sources"] = [];
  const offsets = await pageOffsets(sources);

  sources.forEach((source, index) => {
    const file = files.find((f) => f.index === source.fileIndex);
    const geometry = loaded.get(source) ?? null;
    const offset = offsets.get(source.fileIndex) ?? 0;

    for (const page of geometry?.pages ?? []) {
      const layout = pageLayout(page);
      pages.push({
        i: offset + page.i,
        src: index,
        p: page.i + 1,
        w: page.w,
        h: page.h,
        rot: page.rot,
        content: layout.content,
        columns: layout.columns,
      });
      geometryPages.push(page);
    }

    sourceEntries.push({
      index,
      filename: source.filename,
      url: file ? `/pdf/${file.id}` : `/pdf/book/${book.id}`,
      pageCount: geometry?.pages.length ?? 0,
    });
  });

  const rows = await db.select().from(chapters).where(eq(chapters.bookId, book.id)).orderBy(asc(chapters.index));

  return {
    format: READER_FORMAT,
    book: {
      id: book.id,
      title: book.title,
      author: book.author,
      language: languageCode(book.language),
      medianBodyPt: medianBodyPt(geometryPages),
      // Nothing serves a cover over HTTP; a container carries one and says where
      cover: null,
    },
    sources: sourceEntries,
    pages,
    chapters: rows.map((chapter) => {
      const offset = offsets.get(chapter.sourceFileIndex) ?? 0;
      return {
        i: chapter.index,
        id: chapter.id,
        title: chapter.title,
        audio: chapter.audioPath ? `/audio/chapter/${chapter.id}` : null,
        cues: chapter.audioPath ? `/read/chapter/${chapter.id}/cues.json` : null,
        text: chapterText(chapter) ? `/read/chapter/${chapter.id}/text.json` : null,
        durationMs: chapter.durationMs,
        pageStart: chapter.pageStart === null ? null : offset + chapter.pageStart - 1,
        pageEnd: chapter.pageEnd === null ? null : offset + chapter.pageEnd - 1,
        ...chapterMode(chapter),
      };
    }),
  };
}

// Flat page index of each source's first page — a chapter's page numbers are relative to its own
// file. The manifest and the cue rects both number pages by this, so they cannot drift apart.
const loaded = new WeakMap<MarkerSource, Awaited<ReturnType<typeof ensureSourceGeometry>>>();

async function pageOffsets(sources: MarkerSource[]): Promise<Map<number | null, number>> {
  const geometries = await Promise.all(sources.map((source) =>
    ensureSourceGeometry(source).catch((error: unknown) => {
      console.error(`Page geometry for ${source.filename}: ${describeError(error)}`);
      return null;
    }),
  ));
  const offsets = new Map<number | null, number>();
  let flat = 0;
  sources.forEach((source, index) => {
    loaded.set(source, geometries[index] ?? null);
    offsets.set(source.fileIndex, flat);
    flat += geometries[index]?.pages.length ?? 0;
  });
  return offsets;
}

type ResolvedRects = { rects: CueRect[]; words: CueRect[][] | null };

async function resolveRects(chapter: Chapter, cues: Cue[]): Promise<ResolvedRects[]> {
  const empty = cues.map(() => ({ rects: [], words: null }));
  if (chapterMode(chapter).mode === "text" || !chapter.cleanText) return empty;

  const [book] = await db.select().from(books).where(eq(books.id, chapter.bookId));
  if (!book) return empty;

  const sources = await listMarkerSources(book);
  const source = sources.find((s) => s.fileIndex === chapter.sourceFileIndex) ?? sources[0];
  if (!source) return empty;

  const offsets = await pageOffsets(sources);
  const geometry = loaded.get(source) ?? null;
  const offset = offsets.get(source.fileIndex) ?? 0;
  const cleanText = chapter.cleanText;

  const context = {
    cleanText,
    textMap: chapter.textMap!,
    blocks: chapter.sourceBlocks as SourceBlock[],
    page: (blockPage: number) => ({
      index: offset + blockPage - 1,
      geometry: geometry?.pages[blockPage - 1] ?? null,
    }),
  };

  const ranges = locateChunks(cleanText, cues.map((cue) => cue.text));

  return cues.map((cue, i) => {
    const range = ranges[i];
    if (!range) return { rects: [], words: null };

    const rects = rectsForRange(context, range.start, range.end);
    if (!cue.words) return { rects, words: null };

    // The words are located inside the cue's own slice, so the same whitespace-insensitive
    // matching that placed the cue places each word within it
    const inCue = locateChunks(cleanText.slice(range.start, range.end), cue.words.map((word) => word.text));
    const words = inCue.map((at) =>
      at ? rectsForRange(context, range.start + at.start, range.start + at.end, { linesOnly: true }) : [],
    );
    return { rects, words };
  });
}

// What the rest of the app renders and narrates, in the same order of preference
function chapterText(chapter: Chapter): string {
  return (chapter.customText ?? chapter.cleanText ?? chapter.rawText ?? "").trim();
}

export function buildText(chapter: Chapter): ReaderText | null {
  const text = chapterText(chapter);
  return text ? { format: READER_FORMAT, text } : null;
}

export async function buildCues(chapter: Chapter): Promise<ReaderCues | null> {
  if (!chapter.audioPath) return null;
  const map = await readSyncMap(chapter.audioPath);
  if (!map) return null;

  const { granularity, cues } = cuesFromSyncMap(map);
  const resolved = await resolveRects(chapter, cues);

  return {
    format: READER_FORMAT,
    totalMs: map.totalMs,
    granularity,
    cues: cues.map((cue, i) => {
      const cueRects = resolved[i];
      return {
        t: [cue.startMs, cue.endMs] as [number, number],
        s: cue.text,
        c: cue.chunk,
        ...(cueRects?.rects.length ? { r: cueRects.rects } : {}),
        ...(cue.words ? { w: cue.words.map(wordTuple) } : {}),
        ...(cueRects?.words ? { wr: cueRects.words } : {}),
      };
    }),
  };
}

function wordTuple(word: SyncWord): [number, number, string] {
  return [word.startMs, word.endMs, word.text];
}

export async function chapterForReader(chapterId: string): Promise<Chapter | null> {
  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
  return chapter ?? null;
}

export async function bookForReader(bookId: string): Promise<Book | null> {
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  return book ?? null;
}
