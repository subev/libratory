import { db } from "../db.ts";
import { chapters, books, documents, chapterVariants } from "../schema.ts";
import { eq, asc, and } from "drizzle-orm";
import { renderChapterDocuments, renderDocumentHtml, type DocumentChapter } from "../lib/document-html.ts";
import { buildChapterEpub, buildDocument } from "../lib/vivliostyle.ts";
import { bookOutputDir, bookTmpDir } from "../lib/paths.ts";
import { appendLog } from "../lib/log.ts";
import { languageSlug, translationChunkPreviewDir } from "./synthesize-translation.ts";
import { chapterChunkPreviewDir } from "../lib/chunk-previews.ts";
import { ensureSyncMap } from "../lib/sync-map.ts";
import { buildReadaloudEpub, type ReadaloudChapter } from "../lib/readaloud-epub.ts";
import { buildP2afLayer, buildVariantP2afLayer, buildTextP2afLayer } from "../lib/p2af.ts";
import { attachReaderLayer, attachTextReaderLayer } from "../lib/epub-reader-layer.ts";
import { buildManifest, chapterLink } from "../lib/reader-doc.ts";
import { deferUntilInputsSettle, documentJobKey, outputChapters } from "../lib/output-readiness.ts";
import type { WorkerUtils } from "graphile-worker";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

import { buildBilingualExportLayer, type BilingualExportOptions } from "../lib/bilingual-export.ts";

export type AssembleDocumentPayload = {
  bookId: string;
  language?: string;
  format: "pdf" | "epub" | "epub-sync" | "epub-bilingual";
  bilingual?: BilingualExportOptions;
  waitForAll?: boolean;
  waitingSince?: string;
  // Only these chapters; the selection when absent
  chapterIds?: string[];
};

export async function assembleDocument(
  payload: AssembleDocumentPayload,
  { addJob }: { addJob: WorkerUtils["addJob"] },
) {
  const { bookId, language, format, chapterIds } = payload;
  const log = (msg: string) => appendLog(bookId, msg);
  const formatLabel = format === "epub-bilingual" ? "Bilingual EPUB" : format === "epub-sync" ? "synced EPUB" : format.toUpperCase();

  if (payload.waitForAll && format !== "epub-bilingual") {
    const deferred = await deferUntilInputsSettle({
      identifier: "assembleDocument",
      payload,
      jobKey: documentJobKey(bookId, format, language, chapterIds),
      language,
      needs: format === "epub-sync" ? "audio" : "text",
      addJob,
      log,
    });
    if (deferred) return;
  }

  await db.update(books).set({ status: "assembling", updatedAt: new Date() }).where(eq(books.id, bookId));
  await log(language ? `Starting ${formatLabel} export (${language})` : `Starting ${formatLabel} export`);

  try {
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    if (!book) throw new Error(`Book ${bookId} not found`);

    if (format === "epub-bilingual") {
      if (!language || !payload.bilingual) throw new Error("Choose a translation and narration options for Bilingual EPUB");
      await assembleBilingual(book, language, payload.bilingual, log, chapterIds);
      await db.update(books).set({ status: "done", error: null, updatedAt: new Date() }).where(eq(books.id, bookId));
      await log("Bilingual EPUB export complete");
      return;
    }

    if (format === "epub-sync") {
      await assembleReadaloud(bookId, book, language ?? null, log, chapterIds);
      await db.update(books).set({ status: "done", error: null, updatedAt: new Date() }).where(eq(books.id, bookId));
      await log("Synced EPUB export complete");
      return;
    }

    let docChapters: (DocumentChapter & { id: string })[];
    let selectedCount: number;

    if (language) {
      const rows = await db
        .select({
          id: chapters.id,
          index: chapters.index,
          originalTitle: chapters.title,
          customText: chapters.customText,
          cleanText: chapters.cleanText,
          rawText: chapters.rawText,
          translatedTitle: chapterVariants.title,
          translatedText: chapterVariants.text,
          translationStatus: chapterVariants.status,
        })
        .from(chapterVariants)
        .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
        .where(and(
          outputChapters(bookId, chapterIds),
          eq(chapterVariants.key, language),
        ))
        .orderBy(asc(chapters.index));
      selectedCount = rows.length;
      docChapters = rows
        .filter((r) => r.translationStatus === "done" && r.translatedText.trim())
        .map((r) => ({
          index: r.index,
          title: r.translatedTitle ?? r.originalTitle,
          text: r.translatedText,
          originalTitle: r.originalTitle,
          originalText: r.customText ?? r.cleanText ?? r.rawText,
          id: r.id,
        }));
    } else {
      const selectedChapters = await db
        .select()
        .from(chapters)
        .where(outputChapters(bookId, chapterIds))
        .orderBy(asc(chapters.index));
      selectedCount = selectedChapters.length;
      docChapters = selectedChapters
        .map((ch) => ({
          index: ch.index,
          title: ch.title,
          text: ch.customText ?? ch.cleanText ?? ch.rawText,
          originalTitle: ch.title,
          originalText: ch.customText ?? ch.cleanText ?? ch.rawText,
          id: ch.id,
        }))
        .filter((ch) => ch.text.trim());
    }

    if (docChapters.length === 0) {
      throw new Error(language
        ? `No selected chapters have a finished ${language} translation`
        : "No selected chapters have text");
    }

    await log(`${docChapters.length} of ${selectedCount} selected chapter${selectedCount !== 1 ? "s" : ""} have text`);

    const outDir = bookOutputDir(bookId);
    const tmpDir = bookTmpDir(bookId);
    await mkdir(outDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });

    const timestamp = formatTimestamp(new Date());
    const suffix = language ? `_${languageSlug(language)}` : "";
    const outputPath = path.join(outDir, `${sanitizeFilename(book.title)}${suffix}_${timestamp}.${format}`);

    await log(`Rendering ${format.toUpperCase()} with Vivliostyle (${docChapters.length} chapters)`);
    // One scratch directory per run, removed whether the build succeeds or not: a failed export
    // used to leave its input behind, once per attempt, until the book itself was deleted.
    const workDir = path.join(tmpDir, `${format}${suffix}_${timestamp}`);
    await mkdir(workDir, { recursive: true });
    try {
      if (format === "epub") {
        const { language: documentLanguage, documents: chapterDocs } = renderChapterDocuments(docChapters);
        await buildChapterEpub(workDir, { title: book.title, language: documentLanguage, documents: chapterDocs }, outputPath);
        if (!language) {
          const layer = await buildTextP2afLayer(book, docChapters);
          await attachTextReaderLayer(outputPath, workDir, layer);
          await log(`Reader text: ${layer.manifest.chapters.length} chapters, ${layer.bilingual?.length ?? 0} bilingual attachments`);
        }
      } else {
        const htmlPath = path.join(workDir, "document.html");
        await writeFile(htmlPath, renderDocumentHtml({ bookTitle: book.title, chapters: docChapters }), "utf-8");
        await buildDocument(htmlPath, outputPath);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    await db.insert(documents).values({
      bookId,
      language: language ?? null,
      format,
      outputPath,
      chapterCount: docChapters.length,
      chapterSummary: buildChapterSummary(docChapters.map((ch) => ch.index)),
      chapterIds: JSON.stringify(docChapters.map((ch) => ch.id)),
    });

    await db
      .update(books)
      .set({ status: "done", error: null, updatedAt: new Date() })
      .where(eq(books.id, bookId));

    await log(`${format.toUpperCase()} export complete`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(`Document export failed: ${message}`);
    await db.update(books).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(books.id, bookId));
    throw err;
  }
}

async function assembleReadaloud(
  bookId: string,
  book: typeof books.$inferSelect,
  language: string | null,
  log: (msg: string) => Promise<void>,
  chapterIds?: string[],
) {
  type Candidate = { id: string; index: number; title: string; audioPath: string | null; durationMs: number | null; chunkDir: string; link?: string };

  let candidates: Candidate[];
  if (language) {
    const rows = await db
      .select({
        id: chapters.id,
        index: chapters.index,
        originalTitle: chapters.title,
        translatedTitle: chapterVariants.title,
        audioPath: chapterVariants.audioPath,
        durationMs: chapterVariants.audioDurationMs,
        audioStatus: chapterVariants.audioStatus,
        source: chapters.source,
      })
      .from(chapterVariants)
      .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
      .where(and(
        outputChapters(bookId, chapterIds),
        eq(chapterVariants.key, language),
      ))
      .orderBy(asc(chapters.index));
    candidates = rows
      .filter((r) => r.audioStatus === "done")
      .map((r) => ({
        id: r.id,
        index: r.index,
        title: r.translatedTitle ?? r.originalTitle,
        audioPath: r.audioPath,
        durationMs: r.durationMs,
        chunkDir: translationChunkPreviewDir(bookId, language, r.index),
        link: chapterLink(r),
      }));
  } else {
    const rows = await db
      .select()
      .from(chapters)
      .where(and(outputChapters(bookId, chapterIds), eq(chapters.status, "done")))
      .orderBy(asc(chapters.index));
    candidates = rows.map((ch) => ({
      id: ch.id,
      index: ch.index,
      title: ch.title,
      audioPath: ch.audioPath,
      durationMs: ch.durationMs,
      chunkDir: chapterChunkPreviewDir(bookId, ch.index),
      link: chapterLink(ch),
    }));
  }

  const readaloudChapters: ReadaloudChapter[] = [];
  const includedIds: string[] = [];
  const skipped: string[] = [];
  for (const ch of candidates) {
    if (!ch.audioPath || !ch.durationMs) {
      skipped.push(ch.title);
      continue;
    }
    const sync = await ensureSyncMap(ch.audioPath, ch.chunkDir, ch.durationMs);
    if (!sync) {
      skipped.push(ch.title);
      continue;
    }
    readaloudChapters.push({ id: ch.id, index: ch.index, title: ch.title, audioPath: ch.audioPath, sync, link: ch.link });
    includedIds.push(ch.id);
  }

  if (skipped.length > 0) {
    await log(`Skipping ${skipped.length} chapter(s) without timing data (no sync map and chunk WAVs already deleted): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`);
  }
  if (readaloudChapters.length === 0) {
    throw new Error(language
      ? `No selected chapters have finished ${language} audio with timing data`
      : "No selected chapters have finished audio with timing data");
  }

  const outDir = bookOutputDir(bookId);
  const tmpDir = bookTmpDir(bookId);
  await mkdir(outDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const timestamp = formatTimestamp(new Date());
  const suffix = language ? `_${languageSlug(language)}` : "";
  const stagingDir = path.join(tmpDir, `readaloud${suffix}_${timestamp}`);
  const outputPath = path.join(outDir, `${sanitizeFilename(book.title)}${suffix}_readaloud_${timestamp}.epub`);

  await log(`Building synced EPUB (${readaloudChapters.length} chapters, read-along narration)`);
  try {
    await buildReadaloudEpub({
      title: book.title,
      author: book.author,
      language: language ?? book.language,
      chapters: readaloudChapters,
      stagingDir,
      outputPath,
      p2af: language
        ? async (exported, cover) => {
            const layer = await buildVariantP2afLayer(book, language, exported, cover);
            await log(layer
              ? `Read-along layer: ${layer.cues.length} chapter(s) over their ${language} text`
              : `No read-along layer — no ${language} chapter has timing data`);
            return layer;
          }
        : async (exported, cover) => {
            const layer = await buildP2afLayer(book, exported, cover);
            await log(layer
              ? `Read-along layer: ${layer.cues.length} chapter(s) ${layer.manifest.pages.length > 0 ? `on ${layer.manifest.pages.length} pages` : "over their text, no pages"}`
              : "No read-along layer — this book has no page geometry");
            return layer;
          },
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  await db.insert(documents).values({
    bookId,
    language,
    format: "epub-sync",
    outputPath,
    chapterCount: readaloudChapters.length,
    chapterSummary: buildChapterSummary(readaloudChapters.map((ch) => ch.index)),
    chapterIds: JSON.stringify(includedIds),
  });
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\-\s]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 100) || "book";
}

function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}${mo}${d}_${h}${mi}${s}`;
}

// Build a compact summary like "Ch 1-3, 5, 7-10" from 0-based indices
function buildChapterSummary(indices: number[]): string {
  const [head, ...rest] = indices.map((i) => i + 1).sort((a, b) => a - b);
  if (head === undefined) return "";
  const ranges: string[] = [];
  let start = head;
  let end = head;
  for (const num of rest) {
    if (num === end + 1) {
      end = num;
    } else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = num;
      end = num;
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return `Ch ${ranges.join(", ")}`;
}

// Two shapes of file. A printed book exported with its original recording takes the synced
// EPUB's route, so the reader gets the pages, the cues and the pairing together and can show
// the print beside the translation. Anything else — no print, or no original recording — is
// the two texts with whatever recordings were chosen.
async function assembleBilingual(book: typeof books.$inferSelect, key: string, options: BilingualExportOptions, log: (message: string) => Promise<void>, chapterIds?: string[]) {
  const timestamp = formatTimestamp(new Date());
  const languages = `${languageSlug(book.language ?? "original")}-${languageSlug(key)}`;
  const voices = [options.sourceAudio ? "original" : "", options.targetAudio ? languageSlug(key) : ""].filter(Boolean).join("-") || "none";
  const withPages = options.sourceAudio && (await buildManifest(book)).pages.length > 0;
  const basename = `${sanitizeFilename(book.title)}_bilingual_${languages}_audio-${voices}${withPages ? "_pages" : ""}_${timestamp}`;
  const outputPath = path.join(bookOutputDir(book.id), `${basename}.epub`);
  const workDir = path.join(bookTmpDir(book.id), basename);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(workDir, { recursive: true });
  try {
    let selected: { id: string; index: number }[];
    if (withPages) {
      const rows = await db.select().from(chapters)
        .where(outputChapters(book.id, chapterIds)).orderBy(asc(chapters.index));
      // The pairing was checked at the route; here only the recordings can be missing, and a
      // chapter without one keeps its pages and both texts.
      const narrated: ReadaloudChapter[] = [];
      for (const ch of rows) {
        if (ch.status !== "done" || !ch.audioPath || !ch.durationMs) continue;
        const sync = await ensureSyncMap(ch.audioPath, chapterChunkPreviewDir(book.id, ch.index), ch.durationMs);
        if (!sync) continue;
        narrated.push({ id: ch.id, index: ch.index, title: ch.title, audioPath: ch.audioPath, sync, link: chapterLink(ch) });
      }
      if (narrated.length === 0) throw new Error("No selected chapter has a timed original recording; uncheck the original recording to export the texts alone");
      selected = rows.map((ch) => ({ id: ch.id, index: ch.index }));
      await log(`Exporting ${rows.length} bilingual chapter${rows.length === 1 ? "" : "s"} with their pages · ${languages}`);
      await buildReadaloudEpub({
        title: book.title, author: book.author, language: book.language, chapters: narrated,
        stagingDir: workDir, outputPath,
        p2af: async (exported, cover) => {
          const layer = await buildP2afLayer(book, exported, cover, [key], { targetAudio: options.targetAudio, chapters: new Set(rows.map((ch) => ch.id)) });
          if (!layer) throw new Error("The pages could not be packaged; export again after the book's pages have been built");
          const missing = rows.filter((ch) => !layer.manifest.chapters.find((entry) => entry.id === ch.id)?.bilingual?.length);
          if (missing.length) throw new Error(`The pairing or a recording changed since it was checked; prepare again and export: ${missing.slice(0, 3).map((ch) => `${ch.index + 1}. ${ch.title}`).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}`);
          return layer;
        },
      });
    } else {
      const { layer, chapters: exported } = await buildBilingualExportLayer(book, key, options, chapterIds);
      selected = exported;
      const { language, documents: rendered } = renderChapterDocuments(exported.map((chapter) => ({ ...chapter, originalTitle: chapter.title, originalText: chapter.text })));
      await log(`Exporting ${exported.length} bilingual chapter${exported.length === 1 ? "" : "s"} · ${languages}`);
      await buildChapterEpub(workDir, { title: book.title, language, documents: rendered }, outputPath);
      await attachReaderLayer(outputPath, workDir, layer);
    }
    await db.insert(documents).values({ bookId: book.id, language: key, format: "epub-bilingual",
      outputPath, chapterIds: JSON.stringify(selected.map((chapter) => chapter.id)), chapterCount: selected.length, chapterSummary: buildChapterSummary(selected.map((chapter) => chapter.index)) });
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
