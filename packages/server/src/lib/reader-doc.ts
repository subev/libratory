import { voiceLabel } from "./document-narration.ts";
import { bilingualReferencesForBook } from "./bilingual-document.ts";
import { bookFileOrder } from "./book-file-order.ts";
import { asc, eq } from "drizzle-orm";

import { db } from "../db.ts";
import { bookFiles, chapters, books, type Book, type Chapter } from "../schema.ts";
import { cuesFromSyncMap, type Cue } from "./cues.ts";
import { rectsForRange, type RectContext } from "./cue-rects.ts";
import { describeError } from "./errors.ts";
import { locateChunks } from "./chunk-previews.ts";
import { listMarkerSources, type MarkerSource } from "./marker-sources.ts";
import { languageCode } from "./readaloud-epub.ts";
import { ensureSourceGeometry, medianBodyPt, pageLayout, type GeometryPage } from "./page-geometry.ts";
import { readSyncMap, type SyncWord } from "./sync-map.ts";
import { chapterText } from "./chapter-text.ts";
import type { SourceBlock } from "./marker.ts";
import { joinTextBlocks } from "./extracted-text.ts";
import { normalizeBlocks } from "./normalizer.ts";
import { alignTexts, KEPT, type Span, type TextAlignment } from "./text-alignment.ts";
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

// Synthetic, never narrated, or edited past recognition — no rects rather than wrong ones, and
// the reason travels with the document so a reader can say which it was. The pages are
// unaffected: they come from the PDF, so a chapter that cannot be marked is still a chapter that
// can be read. An edit that corrected the text rather than replacing it keeps its marks, placed
// through the alignment, and says how much of what is spoken the print still holds.
export function chapterMode(chapter: Chapter): Pick<ReaderChapter, "mode" | "why" | "fit"> {
  if (!Array.isArray(chapter.sourceBlocks)) return { mode: "text", why: "generated" };
  const alignment = chapter.customText === null ? null : editAlignment(chapter);
  if (chapter.customText !== null && !alignment) return { mode: "text", why: "edited" };
  if (!chapter.textMap) return { mode: "text", why: chapter.audioPath ? "unmapped" : "unnarrated" };
  return alignment ? { mode: "page", fit: Math.round(alignment.fit * 100) / 100 } : { mode: "page" };
}

// The manifest asks for every chapter on every poll, and the diff is the one expensive thing
// here, so the last answer is kept per chapter for as long as the two texts it was built from stand
const ALIGNMENTS = new Map<string, { texts: string; alignment: TextAlignment | null }>();
const ALIGNMENTS_KEPT = 256;

export function editAlignment(chapter: Pick<Chapter, "id" | "customText" | "cleanText">): TextAlignment | null {
  if (!chapter.customText || !chapter.cleanText) return null;
  const texts = `${fingerprint(chapter.customText)}:${fingerprint(chapter.cleanText)}`;
  const cached = ALIGNMENTS.get(chapter.id);
  if (cached && cached.texts === texts) return cached.alignment;
  const built = alignTexts(chapter.customText, chapter.cleanText);
  const alignment = built && built.fit >= KEPT ? built : null;
  if (ALIGNMENTS.size >= ALIGNMENTS_KEPT) ALIGNMENTS.delete(ALIGNMENTS.keys().next().value!);
  ALIGNMENTS.set(chapter.id, { texts, alignment });
  return alignment;
}

// FNV-1a with the length: enough to tell one save of a chapter from the next, without holding
// two copies of every edited chapter in memory for the comparison
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}.${hash.toString(16)}`;
}

// Only a chapter made from a page on the web has somewhere to send a reader; a digest's source
// is another book here, and a note's is a note. The API takes any URL, and this one ends up as an
// anchor in a file that travels, so nothing but the web leaves.
export function chapterLink(chapter: Pick<Chapter, "source">): string | undefined {
  if (chapter.source?.kind !== "url") return undefined;
  return /^https?:\/\//i.test(chapter.source.url) ? chapter.source.url : undefined;
}

export async function buildManifest(book: Book): Promise<ReaderManifest> {
  const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, book.id)).orderBy(bookFileOrder, asc(bookFiles.index));
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

  const bilingual = await bilingualReferencesForBook(book.id);
  return {
    format: READER_FORMAT,
    book: {
      id: book.id,
      title: book.title,
      author: book.author,
      description: book.description,
      language: languageCode(book.language),
      medianBodyPt: medianBodyPt(geometryPages),
      // Nothing serves a cover over HTTP; a container carries one and says where
      cover: null,
    },
    sources: sourceEntries,
    pages,
    chapters: rows.map((chapter) => {
      const offset = offsets.get(chapter.sourceFileIndex) ?? 0;
      const link = chapterLink(chapter);
      return {
        i: chapter.index,
        id: chapter.id,
        title: chapter.title,
        audio: chapter.audioPath ? `/audio/chapter/${chapter.id}` : null,
        cues: chapter.audioPath ? `/read/chapter/${chapter.id}/cues.json` : null,
        text: chapterText(chapter).trim() ? `/read/chapter/${chapter.id}/text.json` : null,
        durationMs: chapter.durationMs,
        voice: chapter.audioPath ? voiceLabel(chapter.synthesizedWith?.voice) : null,
        pageStart: chapter.pageStart === null ? null : offset + chapter.pageStart - 1,
        pageEnd: chapter.pageEnd === null ? null : offset + chapter.pageEnd - 1,
        ...chapterMode(chapter),
        bilingual: bilingual.filter((r) => r.chapterId === chapter.id).map(({ key, language, url }) => ({ key, language, url })),
        ...(link ? { link: { url: link } } : {}),
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

// Read off the pages themselves rather than off the rects that came back: a chapter whose engine
// never timed a word has no word rects to count, and its print is no less markable for it.
//
// Not knowing is not the same as knowing there is nothing to mark. Geometry that failed to build,
// and a chapter that never landed on a page, both leave nothing to read — and the reader states
// this to someone as a fact about their book, so it says nothing rather than the wrong thing.
export function printMarks(
  pages: GeometryPage[] | null,
  chapter: Pick<Chapter, "pageStart" | "pageEnd">,
): ReaderCues["marks"] {
  if (!pages || chapter.pageStart === null) return undefined;
  const last = chapter.pageEnd ?? chapter.pageStart;
  return pages.slice(chapter.pageStart - 1, last).some((page) => page.lines.length > 0)
    ? "word"
    : "paragraph";
}

type ResolvedRects = { rects: CueRect[]; words: CueRect[][] | null };
type Resolved = { perCue: ResolvedRects[]; marks: ReaderCues["marks"] };

async function resolveRects(chapter: Chapter, cues: Cue[]): Promise<Resolved> {
  const empty: Resolved = { perCue: cues.map(() => ({ rects: [], words: null })), marks: undefined };
  if (chapterMode(chapter).mode === "text" || !chapter.cleanText) return empty;

  const [book] = await db.select().from(books).where(eq(books.id, chapter.bookId));
  if (!book) return empty;

  const sources = await listMarkerSources(book);
  const source = sources.find((s) => s.fileIndex === chapter.sourceFileIndex) ?? sources[0];
  if (!source) return empty;

  const offsets = await pageOffsets(sources);
  const geometry = loaded.get(source) ?? null;
  const offset = offsets.get(source.fileIndex) ?? 0;

  const context = {
    cleanText: chapter.cleanText,
    textMap: chapter.textMap!,
    blocks: chapter.sourceBlocks as SourceBlock[],
    page: (blockPage: number) => ({
      index: offset + blockPage - 1,
      geometry: geometry?.pages[blockPage - 1] ?? null,
    }),
  };

  return {
    perCue: placeCues(context, cues, chapter.customText === null ? null : { text: chapter.customText, alignment: editAlignment(chapter)! }),
    marks: printMarks(geometry?.pages ?? null, chapter),
  };
}

// Cues are slices of whatever was narrated. Narrated after an edit, a cue is found in the edited
// text and carried onto the original through the alignment, where the map and the geometry are;
// edited after narration, it is still found in the original itself. Either way a cue the text no
// longer holds places nothing, and so does a sentence typed in that the print never had.
export function placeCues(context: RectContext, cues: Cue[], edited: { text: string; alignment: TextAlignment } | null): ResolvedRects[] {
  const texts = cues.map((cue) => cue.text);
  const inOriginal = locateChunks(context.cleanText, texts);
  const inEdited = edited ? locateChunks(edited.text, texts) : [];
  const same = (start: number, end: number): Span => [start, end];

  return cues.map((cue, i) => {
    const at = inEdited[i];
    const placed = at && edited
      ? { text: edited.text, range: at, map: edited.alignment.toOriginal }
      : inOriginal[i] ? { text: context.cleanText, range: inOriginal[i], map: same } : null;
    if (!placed) return { rects: [], words: null };

    const span = placed.map(placed.range.start, placed.range.end);
    const rects = span ? rectsForRange(context, span[0], span[1]) : [];
    if (!cue.words) return { rects, words: null };

    // The words are located inside the cue's own slice, so the same whitespace-insensitive
    // matching that placed the cue places each word within it
    const inCue = locateChunks(placed.text.slice(placed.range.start, placed.range.end), cue.words.map((word) => word.text));
    const words = inCue.map((word) => {
      const mapped = word ? placed.map(placed.range.start + word.start, placed.range.start + word.end) : null;
      return mapped ? rectsForRange(context, mapped[0], mapped[1], { linesOnly: true }) : [];
    });
    return { rects, words };
  });
}

export function buildText(chapter: Chapter): ReaderText | null {
  const text = chapterText(chapter).trim();
  if (!text) return null;
  const plain = { format: READER_FORMAT, text };
  // Written text has no typed blocks for an edit to invalidate, only the paragraphs it was written in
  if (!Array.isArray(chapter.sourceBlocks)) return { ...plain, blocks: paragraphBlocks(text) };
  const blocks = chapter.sourceBlocks as SourceBlock[];
  const raw = joinTextBlocks(blocks);
  if (raw.text !== chapter.rawText || !blocks.some((block) => block.kind)) return plain;
  const joined = chapter.cleanText === null ? raw : normalizeBlocks(blocks);
  const typed = (span: { start: number; end: number; block: number }) => {
    const block = blocks[span.block];
    return { start: span.start, end: span.end, kind: block?.kind ?? "prose", ...(block?.breakBefore ? { breakBefore: block.breakBefore } : {}) };
  };
  if (chapter.customText === null) {
    if (joined.text !== text) return plain;
    return { ...plain, blocks: joined.spans.map(typed) };
  }
  // The typed blocks describe the text before the edit; what survives of each is found through
  // the alignment, and what the edit typed in between falls into the block before it
  const alignment = editAlignment(chapter);
  if (!alignment || joined.text !== chapter.cleanText) return plain;
  const trimmedBy = chapterText(chapter).length - chapterText(chapter).trimStart().length;
  const mapped = joined.spans.flatMap((span) => {
    const at = alignment.toEdited(span.start, span.end);
    return at ? [{ ...typed(span), start: at[0] - trimmedBy, end: at[1] - trimmedBy }] : [];
  });
  return mapped.length ? { ...plain, blocks: coverGaps(text, mapped) } : plain;
}

type TextBlock = NonNullable<ReaderText["blocks"]>[number];

// Blocks are all a reader draws, so between them nothing may be left. What the alignment did not
// place — the punctuation around a block's words, a paragraph typed in — is handed out by the
// blank lines: text on the same paragraph as a block joins it, the one before it first, and a
// paragraph of its own reads as prose, whatever its neighbours are. A prose block that came to
// hold a blank line is split at it, so a paragraph typed into one reads as a paragraph.
function coverGaps(text: string, blocks: TextBlock[]): TextBlock[] {
  const covered: TextBlock[] = [];
  let cursor = 0;
  const fill = (from: number, to: number, next: TextBlock | null) => {
    const previous = covered.at(-1);
    const paragraphs = paragraphBlocks(text.slice(from, to)).map((p) => ({ start: from + p.start, end: from + p.end }));
    paragraphs.forEach((paragraph, k) => {
      if (k === 0 && previous && !blankLineBetween(text, previous.end, paragraph.start)) previous.end = paragraph.end;
      else if (k === paragraphs.length - 1 && next && !blankLineBetween(text, paragraph.end, next.start)) next.start = paragraph.start;
      else covered.push({ start: paragraph.start, end: paragraph.end, kind: "prose" });
    });
  };
  blocks.forEach((block, i) => {
    // A word the print split across two blocks — a hyphenated line end filed as its own block —
    // is claimed by both; the later block keeps it, and a block with nothing else left goes
    const next = blocks[i + 1];
    const own = { ...block, start: Math.max(block.start, cursor), end: next && next.start < block.end ? next.start : block.end };
    if (own.end <= own.start) return;
    fill(cursor, own.start, own);
    covered.push(own);
    cursor = own.end;
  });
  fill(cursor, text.length, null);
  return covered.flatMap((block) => {
    if (block.kind !== "prose") return [block];
    return paragraphBlocks(text.slice(block.start, block.end)).map((paragraph, i) => {
      const { breakBefore, ...rest } = block;
      return { ...(i === 0 && breakBefore ? block : rest), start: block.start + paragraph.start, end: block.start + paragraph.end };
    });
  });
}

function blankLineBetween(text: string, from: number, to: number): boolean {
  return /\n[ \t]*\n/.test(text.slice(from, to));
}

export async function buildCues(chapter: Chapter): Promise<ReaderCues | null> {
  if (!chapter.audioPath) return null;
  const map = await readSyncMap(chapter.audioPath);
  if (!map) return null;
  const parsed = cuesFromSyncMap(map);
  return cuesDocument(map.totalMs, parsed, buildText(chapter), await resolveRects(chapter, parsed.cues));
}

// A variant's narration over its own text: a translation or rewrite is not what the print says,
// so it is read the way a written book is, paragraph blocks and no page rects.
export async function buildVariantCues(audioPath: string, text: string): Promise<ReaderCues | null> {
  const map = await readSyncMap(audioPath);
  if (!map) return null;
  const trimmed = text.trim();
  const readerText = trimmed ? { format: READER_FORMAT, text: trimmed, blocks: paragraphBlocks(trimmed) } : null;
  const parsed = cuesFromSyncMap(map);
  return cuesDocument(map.totalMs, parsed, readerText, { perCue: parsed.cues.map(() => ({ rects: [], words: null })), marks: undefined });
}

function cuesDocument(
  totalMs: number,
  { granularity, cues }: ReturnType<typeof cuesFromSyncMap>,
  text: ReaderText | null,
  resolved: Resolved,
): ReaderCues {
  const ranges = text ? locateChunks(text.text, cues.map((cue) => cue.text)) : [];

  return {
    format: READER_FORMAT,
    totalMs,
    granularity,
    marks: resolved.marks,
    ...(text ? { text } : {}),
    cues: cues.map((cue, i) => {
      const cueRects = resolved.perCue[i];
      return {
        ...(ranges[i] ? { range: [ranges[i].start, ranges[i].end] as [number, number] } : {}),
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

function paragraphBlocks(text: string): NonNullable<ReaderText["blocks"]> {
  const blocks: NonNullable<ReaderText["blocks"]> = [];
  for (const match of text.matchAll(/\S(?:[^\n]|\n(?![ \t]*\n))*/g)) {
    const body = match[0].trimEnd();
    blocks.push({ start: match.index, end: match.index + body.length, kind: "prose" });
  }
  return blocks;
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
