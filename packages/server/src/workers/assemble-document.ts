import { db } from "../db.ts";
import { chapters, books, documents, chapterVariants } from "../schema.ts";
import { eq, asc, and } from "drizzle-orm";
import { renderDocumentHtml, type DocumentChapter } from "../lib/document-html.ts";
import { buildDocument } from "../lib/vivliostyle.ts";
import { bookOutputDir, bookTmpDir } from "../lib/paths.ts";
import { appendLog } from "../lib/log.ts";
import { languageSlug, translationChunkPreviewDir } from "./synthesize-translation.ts";
import { chapterChunkPreviewDir } from "../lib/chunk-previews.ts";
import { ensureSyncMap } from "../lib/sync-map.ts";
import { buildReadaloudEpub, type ReadaloudChapter } from "../lib/readaloud-epub.ts";
import { buildP2afLayer } from "../lib/p2af.ts";
import { deferUntilInputsSettle, documentJobKey } from "../lib/output-readiness.ts";
import type { WorkerUtils } from "graphile-worker";
import { mkdir, writeFile, unlink, rm, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.ts";

export type AssembleDocumentPayload = {
  bookId: string;
  language?: string;
  format: "pdf" | "epub" | "epub-sync";
  copyToDropDir?: boolean;
  waitForAll?: boolean;
  waitingSince?: string;
};

export async function assembleDocument(
  payload: AssembleDocumentPayload,
  { addJob }: { addJob: WorkerUtils["addJob"] },
) {
  const { bookId, language, format } = payload;
  const log = (msg: string) => appendLog(bookId, msg);
  const formatLabel = format === "epub-sync" ? "synced EPUB" : format.toUpperCase();

  if (payload.waitForAll) {
    const deferred = await deferUntilInputsSettle({
      identifier: "assembleDocument",
      payload,
      jobKey: documentJobKey(bookId, format, language),
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

    if (format === "epub-sync") {
      await assembleReadaloud(bookId, book, language ?? null, payload.copyToDropDir ?? false, log);
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
          eq(chapters.bookId, bookId),
          eq(chapters.selected, true),
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
        .where(and(eq(chapters.bookId, bookId), eq(chapters.selected, true)))
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

    const html = renderDocumentHtml({ bookTitle: book.title, chapters: docChapters });

    const outDir = bookOutputDir(bookId);
    const tmpDir = bookTmpDir(bookId);
    await mkdir(outDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });

    const timestamp = formatTimestamp(new Date());
    const suffix = language ? `_${languageSlug(language)}` : "";
    const htmlPath = path.join(tmpDir, `document${suffix}_${timestamp}.html`);
    const outputPath = path.join(outDir, `${sanitizeFilename(book.title)}${suffix}_${timestamp}.${format}`);

    await writeFile(htmlPath, html, "utf-8");
    await log(`Rendering ${format.toUpperCase()} with Vivliostyle (${docChapters.length} chapters)`);
    await buildDocument(htmlPath, outputPath);
    await unlink(htmlPath).catch(() => {});

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
  copyToDropDir: boolean,
  log: (msg: string) => Promise<void>,
) {
  type Candidate = { id: string; index: number; title: string; audioPath: string | null; durationMs: number | null; chunkDir: string };

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
      })
      .from(chapterVariants)
      .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
      .where(and(
        eq(chapters.bookId, bookId),
        eq(chapters.selected, true),
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
      }));
  } else {
    const rows = await db
      .select()
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.selected, true), eq(chapters.status, "done")))
      .orderBy(asc(chapters.index));
    candidates = rows.map((ch) => ({
      id: ch.id,
      index: ch.index,
      title: ch.title,
      audioPath: ch.audioPath,
      durationMs: ch.durationMs,
      chunkDir: chapterChunkPreviewDir(bookId, ch.index),
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
    readaloudChapters.push({ id: ch.id, index: ch.index, title: ch.title, audioPath: ch.audioPath, sync });
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
      language,
      chapters: readaloudChapters,
      stagingDir,
      outputPath,
      p2af: language
        ? undefined
        : async (exported, cover) => {
            const layer = await buildP2afLayer(book, exported, cover);
            await log(layer
              ? `Read-along layer: ${layer.cues.length} chapter(s) on ${layer.manifest.pages.length} pages`
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

  if (copyToDropDir && env.READALOUD_DROP_DIR) {
    try {
      await mkdir(env.READALOUD_DROP_DIR, { recursive: true });
      // Storyteller's watch folder skips the entire directory while it holds more than one
      // read-along EPUB ("multiple epubs of the same kind"), so a re-export has to replace
      // its predecessor rather than pile up beside it — otherwise nothing imports again.
      const superseded = `${sanitizeFilename(book.title)}${suffix}_readaloud_`;
      const keep = path.basename(outputPath);
      for (const name of await readdir(env.READALOUD_DROP_DIR)) {
        if (name !== keep && name.startsWith(superseded) && name.endsWith(".epub")) {
          await unlink(path.join(env.READALOUD_DROP_DIR, name)).catch(() => {});
          await log(`Removed superseded staged export ${name} from the import folder`);
        }
      }
      await copyFile(outputPath, path.join(env.READALOUD_DROP_DIR, keep));
      await log(`Copied synced EPUB to import folder (${env.READALOUD_DROP_DIR})`);
    } catch (err) {
      await log(`Could not copy to import folder: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
