import { eq } from "drizzle-orm";
import { rm } from "node:fs/promises";
import path from "node:path";

import { db } from "../db.ts";
import { bookFiles, type BookFile, type OcrEngine } from "../schema.ts";
import { runSuryaOcr } from "./ocr-surya.ts";
import { runTesseractOcr, type OcrStats } from "./ocr-tesseract.ts";
import { bookTmpDir } from "./paths.ts";
import { countWords, extractPdfRawText, pdfHasTextLayer } from "./pdf-raw-text.ts";

// Above this share of doubted words a Tesseract read is offered a second pass with Surya.
export const OCR_GARBLED_FRACTION = 0.15;

export type OcrTarget = Pick<BookFile, "id" | "index" | "filename" | "pdfPath" | "searchablePdfPath">;

function percent(fraction: number | null): string | null {
  return fraction === null ? null : `${Math.round(fraction * 100)}%`;
}

/** True when this run wrote a searchable copy; false when the file did not need one. */
export async function ensureTextLayer({
  bookId,
  file,
  engine,
  language,
  force = false,
  log,
  signal,
}: {
  bookId: string;
  file: OcrTarget;
  engine: OcrEngine;
  language: string | null;
  force?: boolean;
  log: (msg: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (file.searchablePdfPath && !force) {
    await log(`"${file.filename}" already has a searchable copy`);
    return false;
  }

  // null means pdftotext could not run at all — a machine fault, not a scan, so it must not force OCR.
  const hasText = await pdfHasTextLayer(file.pdfPath);
  if (hasText !== false) {
    await log(`"${file.filename}" already carries a text layer — no OCR needed`);
    return false;
  }

  const previous = file.searchablePdfPath;
  const outPdfPath = path.join(path.dirname(file.pdfPath), `${path.basename(file.pdfPath, ".pdf")}.ocr.pdf`);
  const workDir = path.join(bookTmpDir(bookId), `ocr_file_${file.index}`);

  let stats: OcrStats;
  switch (engine) {
    case "tesseract":
      stats = await runTesseractOcr({ pdfPath: file.pdfPath, outPdfPath, language, workDir, log, signal });
      break;
    case "surya":
      stats = await runSuryaOcr({ pdfPath: file.pdfPath, outPdfPath, language, workDir, log, signal });
      break;
    default: {
      const unhandled: never = engine;
      throw new Error(`unhandled OCR engine ${unhandled}`);
    }
  }

  if (previous && previous !== outPdfPath) await rm(previous, { force: true }).catch(() => {});

  const rawText = await extractPdfRawText(outPdfPath);
  const rawWords = rawText ? countWords(rawText) : null;

  await db
    .update(bookFiles)
    .set({
      searchablePdfPath: outPdfPath,
      ocrEngine: engine,
      ocrConfidence: stats.confidence,
      ocrLowConfidenceFraction: stats.lowConfidenceFraction,
      ...(rawText ? { rawText, rawWords } : {}),
    })
    .where(eq(bookFiles.id, file.id));

  const confidence = percent(stats.confidence);
  const garbled = percent(stats.lowConfidenceFraction);
  await log(
    `Text layer for "${file.filename}" — ${(rawWords ?? 0).toLocaleString()} words`
      + (confidence ? `, ${confidence} average confidence, ${garbled} of words below the bar` : ""),
  );
  return true;
}
