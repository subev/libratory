import { env } from "../env.ts";
import { db } from "../db.ts";
import { books, bookFiles, folders, type Book, type NoteJob, type OcrEngine } from "../schema.ts";
import { eq, and } from "drizzle-orm";
import { uploadsDir } from "./paths.ts";
import { canonicalKey } from "./llm.ts";
import { parseTtsVoice } from "./tts.ts";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { quickAddJob } from "graphile-worker";

const connectionString = env.DATABASE_URL;

export const MAX_LANGUAGE_CHARS = 8;

// A caller's mistake, as opposed to a failure of ours: routes answer it with 400, tools with the message.
export class PdfBookInputError extends Error {}

export type PdfBookFile = { index: number; filename: string; pdfPath: string };

export type CreatePdfBookInput = {
  files: PdfBookFile[];
  title?: string | null;
  voice?: string;
  speed?: number;
  ocrEngine?: OcrEngine | null;
  llmChapterDetection?: boolean;
  chapterModel?: string | null;
  skipSynthesis?: boolean;
  fullExtract?: boolean;
  language?: string | null;
  folderId?: string | null;
  note?: { prompt: string; model: string };
};

// Every PDF book starts here, whether the files arrived as a multipart upload or from a local
// path: the book id names the directory the files must already sit in, so allocate it first.
export function newPdfBookId(): { bookId: string; pdfDir: string } {
  const bookId = randomUUID();
  return { bookId, pdfDir: path.join(uploadsDir, bookId) };
}

export async function ensurePdfDir(pdfDir: string) {
  await mkdir(pdfDir, { recursive: true });
}

// The display name is metadata; no client-controlled bytes belong in a filesystem path.
export function pdfFileName(index: number): string {
  return `${String(index).padStart(2, "0")}_${randomUUID()}.pdf`;
}

export async function createPdfBook(bookId: string, input: CreatePdfBookInput, profileId: string): Promise<Book> {
  const [firstFile] = input.files;
  if (!firstFile) throw new PdfBookInputError("No PDF files uploaded");

  const title = input.title?.trim() || firstFile.filename.replace(/\.pdf$/i, "").replace(/[_-]/g, " ");
  const voice = input.voice ?? "kokoro:af_heart";
  parseTtsVoice(voice);
  const speed = input.speed ?? 1.0;
  const chapterModel = canonicalKey(input.chapterModel?.trim().slice(0, 64) ?? "") || null;
  const skipSynthesis = input.skipSynthesis ?? false;
  const fullExtract = input.fullExtract ?? false;

  // routes/books.ts bounds this with z.string().max(8), which rejects. Truncating here instead
  // would store "portugue" for "portuguese" — a code matching no voice and no option.
  const language = input.language?.trim() || null;
  if (language && language.length > MAX_LANGUAGE_CHARS) {
    throw new PdfBookInputError(`language must be at most ${MAX_LANGUAGE_CHARS} characters`);
  }
  const folderId = input.folderId || null;
  if (folderId) {
    const [folder] = await db
      .select()
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.profileId, profileId)));
    if (!folder) throw new PdfBookInputError("Folder not found");
  }

  const now = new Date().toISOString();
  const noteJob: NoteJob | undefined = input.note
    ? { status: "queued", prompt: input.note.prompt, model: input.note.model, createdAt: now, updatedAt: now }
    : undefined;

  // One row set or none: a book without its files is a card the UI can never extract.
  const book = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(books)
      .values({
        id: bookId,
        title,
        filename: firstFile.filename,
        pdfPath: firstFile.pdfPath,
        voice,
        speed,
        ocrEngine: input.ocrEngine ?? null,
        llmChapterDetection: input.llmChapterDetection ?? false,
        chapterModel,
        skipSynthesis,
        language,
        folderId,
        profileId,
        ...(noteJob ? { noteJob } : {}),
      })
      .returning();
    if (!inserted) throw new Error("Failed to create book");
    await tx.insert(bookFiles).values(
      input.files.map((f) => ({
        bookId,
        index: f.index,
        filename: f.filename,
        pdfPath: f.pdfPath,
        skipSynthesis,
        status: (fullExtract ? "pending" : "raw") as "pending" | "raw",
      })),
    );
    return inserted;
  });

  await quickAddJob(
    { connectionString },
    "rawExtract",
    { bookId, ...(input.note ? { note: input.note } : {}) },
    { maxAttempts: 1 },
  );
  // Extraction does the OCR inline, per file, so queueing both would read every page twice.
  if (fullExtract) {
    await quickAddJob({ connectionString }, "extract", { bookId }, { maxAttempts: 1, jobKey: `extract:${bookId}`, jobKeyMode: "replace" });
  } else {
    await quickAddJob({ connectionString }, "ocrTextLayer", { bookId }, { maxAttempts: 1 });
  }

  return book;
}
