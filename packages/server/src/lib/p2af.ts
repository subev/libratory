import { and, asc, eq } from "drizzle-orm";

import { db } from "../db.ts";
import { chapters, chapterVariants, type Book } from "../schema.ts";
import { listMarkerSources } from "./marker-sources.ts";
import { languageCode } from "./readaloud-epub.ts";
import { buildCues, buildManifest, buildVariantCues, chapterLink } from "./reader-doc.ts";
import { READER_FORMAT, type ReaderCues, type ReaderManifest } from "./reader-format.ts";

// The reader documents as they ride inside a container, where every URL is a path relative to
// book.json rather than a route on this server. The EPUB layer beside them owns the audio, so
// these point up into it instead of carrying a second copy.
export type P2afLayer = {
  manifest: ReaderManifest;
  cues: { path: string; doc: ReaderCues }[];
  sources: { path: string; pdfPath: string }[];
};

export const P2AF_DIR = "p2af";

// What the p2af layer needs from the EPUB layer beside it: the names it chose for their shared files
export type ExportedChapter = { base: string; audioFile: string };

function sourcePath(index: number): string {
  return `source/${String(index).padStart(2, "0")}.pdf`;
}

// A chapter the export left out keeps its pages and loses its narration — the same shape as a
// chapter nobody has narrated yet, which both readers already know how to show.
export async function buildP2afLayer(
  book: Book,
  exported: Map<string, ExportedChapter>,
  cover: string | null,
): Promise<P2afLayer | null> {
  const manifest = await buildManifest(book);
  // A book with no PDF has no pages to lose, and its layer is cues over text. One that has a PDF
  // and still no pages is geometry that failed to build, and that layer would promise print.
  if (manifest.pages.length === 0 && manifest.sources.length > 0) return null;
  manifest.book.cover = cover;

  const sources = await listMarkerSources(book);
  manifest.sources = manifest.sources.map((source, index) => ({ ...source, url: sourcePath(index) }));

  const rows = await db.select().from(chapters).where(eq(chapters.bookId, book.id)).orderBy(asc(chapters.index));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const cues: P2afLayer["cues"] = [];

  for (const entry of manifest.chapters) {
    // The text lives in the EPUB layer beside this one; a second copy for the reader would be the
    // whole book again, so the container's chapters point at no text document.
    entry.text = null;
    const file = exported.get(entry.id);
    const chapter = byId.get(entry.id);
    const doc = file && chapter ? await buildCues(chapter) : null;
    if (!file || !doc) {
      entry.audio = null;
      entry.cues = null;
      continue;
    }
    const path = `cues/${file.base}.json`;
    entry.audio = `../audio/${file.audioFile}`;
    entry.cues = path;
    cues.push({ path, doc });
  }

  if (cues.length === 0) return null;

  return {
    manifest,
    cues,
    sources: sources.map((source, index) => ({ path: sourcePath(index), pdfPath: source.pdfPath })),
  };
}

// A variant's layer: its narration over its own text, with no pages or sources, because the print
// holds the original's words and not these. Without it the reader imported the export as a plain
// EPUB — text and no voice — although every chapter's audio was in the file.
export async function buildVariantP2afLayer(
  book: Book,
  key: string,
  exported: Map<string, ExportedChapter>,
  cover: string | null,
): Promise<P2afLayer | null> {
  const rows = await db
    .select({ chapter: chapters, variant: chapterVariants })
    .from(chapterVariants)
    .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
    .where(and(eq(chapters.bookId, book.id), eq(chapterVariants.key, key)))
    .orderBy(asc(chapters.index));

  // One key is one lane, so every row shares its kind
  const translation = rows[0]?.variant.kind === "translation";
  const manifest: ReaderManifest = {
    format: READER_FORMAT,
    book: {
      id: book.id,
      title: book.title,
      author: book.author,
      language: languageCode(translation ? key : book.language),
      medianBodyPt: null,
      cover,
    },
    sources: [],
    pages: [],
    chapters: [],
  };
  const cues: P2afLayer["cues"] = [];

  // Only what the export carries: with no pages behind it, a chapter left out would be an empty entry
  for (const { chapter, variant } of rows) {
    const file = exported.get(chapter.id);
    if (!file) continue;
    const doc = variant.audioPath && variant.text ? await buildVariantCues(variant.audioPath, variant.text) : null;
    const link = chapterLink(chapter);
    const path = `cues/${file.base}.json`;
    manifest.chapters.push({
      i: chapter.index,
      id: chapter.id,
      title: variant.title ?? chapter.title,
      audio: doc ? `../audio/${file.audioFile}` : null,
      cues: doc ? path : null,
      text: null,
      durationMs: doc ? variant.audioDurationMs : null,
      pageStart: null,
      pageEnd: null,
      mode: "text",
      why: "generated",
      ...(link ? { link: { url: link } } : {}),
    });
    if (doc) cues.push({ path, doc });
  }

  if (cues.length === 0) return null;
  return { manifest, cues, sources: [] };
}
