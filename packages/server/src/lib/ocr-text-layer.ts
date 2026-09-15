import { and, eq } from "drizzle-orm";
import { rm } from "node:fs/promises";
import path from "node:path";

import { db } from "../db.ts";
import { bookFiles, chapters, type BookFile, type OcrEngine } from "../schema.ts";
import { collectBlocksFromMarkerOutput, type FlatBlock, type SourceBlock } from "./marker.ts";
import { hasLlmLayout, replaceWords, runLlmOcr, type ReplaceStats } from "./ocr-llm.ts";
import { runSuryaOcr } from "./ocr-surya.ts";
import { runTesseractOcr, type OcrStats } from "./ocr-tesseract.ts";
import { adoptDetectedLanguage } from "./detect-language.ts";
import { removeSourceGeometry } from "./page-geometry.ts";
import { bookFileOutDir, bookTmpDir } from "./paths.ts";
import { countWords, extractPdfRawText, pdfHasTextLayer } from "./pdf-raw-text.ts";

// Above this share of doubted words a Tesseract read is offered a second pass with Surya.
export const OCR_GARBLED_FRACTION = 0.15;

export function isGarbled(engine: OcrEngine | null, lowConfidenceFraction: number | null): boolean {
  return engine === "tesseract" && (lowConfidenceFraction ?? 0) >= OCR_GARBLED_FRACTION;
}

export type OcrTarget = Pick<BookFile, "id" | "index" | "filename" | "pdfPath" | "searchablePdfPath" | "ocrEngine" | "rawText">;

// Whether this file's pages have been read. Every engine leaves a searchable copy, except the AI
// engine on a machine with no Tesseract pack to place its words with: then the layout in the
// file's outDir and the text on the row are all there is.
export async function textLayerDone(bookId: string, file: Pick<OcrTarget, "index" | "searchablePdfPath" | "ocrEngine" | "rawText">): Promise<boolean> {
  if (file.searchablePdfPath) return true;
  return file.ocrEngine === "llm" && file.rawText !== null && (await hasLlmLayout(bookFileOutDir(bookId, file.index)));
}

function percent(fraction: number | null): string | null {
  return fraction === null ? null : `${Math.round(fraction * 100)}%`;
}

/** True when this run wrote a searchable copy; false when the file did not need one. */
export async function ensureTextLayer({
  bookId,
  file,
  engine,
  language,
  ocrModel = null,
  force = false,
  hasTextLayer,
  log,
  signal,
}: {
  bookId: string;
  file: OcrTarget;
  engine: OcrEngine;
  language: string | null;
  /** The "llm" engine's model key; the Settings default when null. */
  ocrModel?: string | null;
  force?: boolean;
  /** What pdfHasTextLayer already said, when the caller has asked. */
  hasTextLayer?: boolean | null;
  log: (msg: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<boolean> {
  // The book's engine is the truth: a read the other engine did is stale, not done.
  const done = await textLayerDone(bookId, file);
  const rereading = Boolean(done && file.ocrEngine && file.ocrEngine !== engine);
  if (done && !force && !rereading) {
    await log(file.searchablePdfPath ? `"${file.filename}" already has a searchable copy` : `"${file.filename}" was already read by the AI model`);
    return false;
  }
  if (rereading) await log(`"${file.filename}" was read by ${file.ocrEngine} — reading it again with ${engine}`);

  // null means pdftotext could not run at all — a machine fault, not a scan, so it must not force OCR.
  const scanned = hasTextLayer === undefined ? await pdfHasTextLayer(file.pdfPath) : hasTextLayer;
  if (scanned !== false) return false;

  const previous = file.searchablePdfPath;
  const outPdfPath = path.join(path.dirname(file.pdfPath), `${path.basename(file.pdfPath, ".pdf")}.ocr.pdf`);
  const workDir = path.join(bookTmpDir(bookId), `ocr_file_${file.index}`);

  let stats: OcrStats;
  let rawText: string | null;
  let searchablePdfPath: string | null = outPdfPath;
  let summary: string;
  switch (engine) {
    case "tesseract":
    case "surya": {
      const runner = engine === "tesseract" ? runTesseractOcr : runSuryaOcr;
      stats = await runner({ pdfPath: file.pdfPath, outPdfPath, language, workDir, log, signal });
      rawText = await extractPdfRawText(outPdfPath);
      const confidence = percent(stats.confidence);
      const garbled = percent(stats.lowConfidenceFraction);
      summary = confidence ? `, ${confidence} average confidence, ${garbled} of words below the bar` : "";
      break;
    }
    case "llm": {
      // The layout goes to the file's outDir, where extraction reads it in place of Marker's, the
      // model's own text onto the row, and the words placed on Tesseract's boxes into the copy.
      // Without a pack to place with there is no copy, and one another engine left is stale now.
      const result = await runLlmOcr({ pdfPath: file.pdfPath, outDir: bookFileOutDir(bookId, file.index), outPdfPath, language, workDir, modelKey: ocrModel ?? undefined, log, signal });
      stats = { confidence: result.meanRecall, lowConfidenceFraction: result.lowRecallFraction };
      rawText = result.rawText.trim() ? result.rawText : null;
      searchablePdfPath = result.searchableCopy ? outPdfPath : null;
      const recall = percent(result.meanRecall);
      const placed = percent(result.meanPlaced);
      summary = `, ${result.inputTokens.toLocaleString()} tokens in and ${result.outputTokens.toLocaleString()} out`
        + (recall ? `, ${recall} of the local OCR's words recovered` : "")
        + (placed ? `, ${placed} of the AI's words placed on the page` : "")
        + (result.flaggedPages.length ? `, ${result.flaggedPages.length} page${result.flaggedPages.length === 1 ? "" : "s"} to check` : "");
      break;
    }
    default: {
      const unhandled: never = engine;
      throw new Error(`unhandled OCR engine ${unhandled}`);
    }
  }

  if (previous && previous !== searchablePdfPath) await rm(previous, { force: true }).catch(() => {});
  // The reader's line geometry was built from whatever the file read as before this run
  await removeSourceGeometry(bookFileOutDir(bookId, file.index));

  const rawWords = rawText ? countWords(rawText) : null;

  await db
    .update(bookFiles)
    .set({
      searchablePdfPath,
      ocrEngine: engine,
      ocrConfidence: stats.confidence,
      ocrLowConfidenceFraction: stats.lowConfidenceFraction,
      ...(rawText ? { rawText, rawWords } : {}),
    })
    .where(eq(bookFiles.id, file.id));

  if (rawText) await adoptDetectedLanguage(bookId, rawText, log);

  await log(`Text ${engine === "llm" ? "from the AI model" : "layer"} for "${file.filename}" — ${(rawWords ?? 0).toLocaleString()} words${summary}`);
  return true;
}

const normalizeKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// A chapter keeps the blocks it was cut from. A layout placed again from the same reading has the
// same blocks on the same pages with new polygons, matched by page and text — or by the text's
// start, for a block whose end a later join changed. A block the new layout could not place loses
// its old polygon rather than keeping a box from a copy that no longer exists.
export function matchBlockPolygons(sourceBlocks: SourceBlock[], fresh: FlatBlock[]): { blocks: SourceBlock[]; matched: number } {
  let matched = 0;
  const taken = new Set<FlatBlock>();
  const blocks = sourceBlocks.map((block) => {
    const key = normalizeKey(block.text);
    const onPage = fresh.filter((f) => f.page === block.page && !taken.has(f));
    const hit = onPage.find((f) => normalizeKey(f.text) === key) ?? onPage.find((f) => normalizeKey(f.text).slice(0, 40) === key.slice(0, 40));
    if (!hit) return block;
    taken.add(hit);
    matched++;
    const { polygon: _stale, ...rest } = block;
    return hit.polygon ? { ...rest, polygon: hit.polygon } : rest;
  });
  return { blocks, matched };
}

/** Places an AI-read file's words again from its saved transcription: new copy, new polygons, chapters and audio untouched. */
export async function replaceFileWords({ bookId, file, language, log, signal }: {
  bookId: string;
  file: OcrTarget;
  language: string | null;
  log: (msg: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<ReplaceStats & { blocksRefreshed: number }> {
  const outDir = bookFileOutDir(bookId, file.index);
  const outPdfPath = path.join(path.dirname(file.pdfPath), `${path.basename(file.pdfPath, ".pdf")}.ocr.pdf`);
  const workDir = path.join(bookTmpDir(bookId), `ocr_file_${file.index}`);
  const result = await replaceWords({ pdfPath: file.pdfPath, outDir, outPdfPath, language, workDir, log, signal });
  const searchablePdfPath = result.searchableCopy ? outPdfPath : null;
  if (file.searchablePdfPath && file.searchablePdfPath !== searchablePdfPath) await rm(file.searchablePdfPath, { force: true }).catch(() => {});
  await removeSourceGeometry(outDir);
  await db.update(bookFiles).set({ searchablePdfPath }).where(eq(bookFiles.id, file.id));

  const fresh = await collectBlocksFromMarkerOutput(outDir);
  const rows = await db.select({ id: chapters.id, sourceBlocks: chapters.sourceBlocks }).from(chapters).where(and(eq(chapters.bookId, bookId), eq(chapters.sourceFileIndex, file.index)));
  let blocksRefreshed = 0;
  for (const row of rows) {
    const { blocks, matched } = matchBlockPolygons((row.sourceBlocks ?? []) as SourceBlock[], fresh);
    blocksRefreshed += matched;
    await db.update(chapters).set({ sourceBlocks: blocks }).where(eq(chapters.id, row.id));
  }
  await log(`Words placed again for "${file.filename}" — ${percent(result.meanPlaced) ?? "none"} placed, ${blocksRefreshed} chapter blocks refreshed${result.searchableCopy ? "" : ", no searchable copy"}`);
  return { ...result, blocksRefreshed };
}
