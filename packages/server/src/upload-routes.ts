import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { books, bookFiles, OCR_ENGINES } from "./schema.ts";
import { eq, sql } from "drizzle-orm";
import { bookFileOrder } from "./lib/book-file-order.ts";
import { profileIdFromHeader } from "./trpc.ts";
import { isUuid } from "./lib/uuid.ts";
import { tmpDir, uploadsDir } from "./lib/paths.ts";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { quickAddJob } from "graphile-worker";
import { rm } from "node:fs/promises";
import { createCustomPocketVoice } from "./lib/pocket-voices.ts";
import { UPLOAD_RATE_LIMIT } from "./lib/request-limits.ts";
import { createPdfBook, ensurePdfDir, newPdfBookId, pdfFileName, PdfBookInputError } from "./lib/pdf-books.ts";

const connectionString = env.DATABASE_URL;

const MAX_NOTE_PROMPT_CHARS = 4000;

async function saveUploadedFiles(request: FastifyRequest, pdfDir: string, startIndex: number) {
  const files: { index: number; filename: string; pdfPath: string }[] = [];
  const fields: Record<string, string> = {};

  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      if (!part.filename.toLowerCase().endsWith(".pdf")) continue;
      const idx = startIndex + files.length;
      // The display name is metadata; no client-controlled bytes belong in a filesystem path.
      const safeName = pdfFileName(idx);
      const pdfPath = path.join(pdfDir, safeName);
      await pipeline(part.file, createWriteStream(pdfPath));
      files.push({ index: idx, filename: part.filename, pdfPath });
    } else {
      fields[part.fieldname] = (part as any).value;
    }
  }

  return { files, fields };
}

function parseNoteRequest(fields: Record<string, string>): { prompt: string; model: string } | { error: string } | null {
  const prompt = fields.notePrompt?.trim();
  if (!prompt) return null;
  if (prompt.length > MAX_NOTE_PROMPT_CHARS) {
    return { error: `notePrompt exceeds ${MAX_NOTE_PROMPT_CHARS} characters` };
  }
  const model = fields.noteModel?.trim().slice(0, 64) || "flash";
  return { prompt, model };
}

export function registerUploadRoutes(fastify: FastifyInstance) {
  fastify.post("/upload", { config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (request, reply) => {
    const { bookId, pdfDir } = newPdfBookId();
    await ensurePdfDir(pdfDir);

    const { files, fields } = await saveUploadedFiles(request, pdfDir, 0);

    if (files.length === 0) {
      return reply.code(400).send({ error: "No PDF files uploaded" });
    }

    const note = parseNoteRequest(fields);
    if (note && "error" in note) {
      return reply.code(400).send({ error: note.error });
    }

    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);

    try {
      const book = await createPdfBook(
        bookId,
        {
          files,
          title: fields.title,
          voice: fields.voice,
          speed: fields.speed === undefined ? undefined : parseFloat(fields.speed),
          ocrEngine: OCR_ENGINES.find((e) => e === fields.ocrEngine) ?? null,
          llmChapterDetection: fields.llmChapterDetection === "true",
          chapterModel: fields.chapterModel,
          ocrModel: fields.ocrModel,
          skipSynthesis: fields.skipSynthesis === "true",
          fullExtract: fields.fullExtract === "true",
          language: fields.language,
          folderId: fields.folderId,
          ...(note ? { note } : {}),
        },
        profileId,
      );
      return reply.send(book);
    } catch (err) {
      if (err instanceof PdfBookInputError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  fastify.post("/upload/:bookId", { config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    if (!isUuid(bookId)) return reply.code(400).send({ error: "Invalid book id" });
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    if (!book) {
      return reply.code(404).send({ error: "Book not found" });
    }
    if (book.kind !== "pdf") {
      return reply.code(400).send({ error: "Cannot add PDF files to a synthetic book" });
    }
    const pdfDir = path.join(uploadsDir, book.id);
    await mkdir(pdfDir, { recursive: true });

    // If this is a legacy book with no book_files rows, backfill the original file
    const existingFiles = await db
      .select()
      .from(bookFiles)
      .where(eq(bookFiles.bookId, bookId));

    // …but only for a file that is still on disk. A book whose files were all removed also has no
    // rows, and its pdfPath describes bytes that were deleted with them — never a file to restore.
    if (existingFiles.length === 0 && book.pdfPath && (await stat(book.pdfPath).catch(() => null))) {
      await db.insert(bookFiles).values({
        bookId,
        index: 0,
        filename: book.filename ?? path.basename(book.pdfPath),
        pdfPath: book.pdfPath,
        status: "done",
      });
    }

    const usesFullExtraction =
      existingFiles.some((f) => f.status !== "raw") || existingFiles.length === 0 || book.totalChapters > 0;

    // Find the next file index
    const [nextFile] = await db
      .select({ index: sql<number>`coalesce(max(${bookFiles.index}), -1) + 1`, position: sql<number>`coalesce(max(${bookFileOrder}), -1) + 1` })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, bookId));
    const startIndex = nextFile?.index ?? 0;
    const startPosition = nextFile?.position ?? 0;

    const { files } = await saveUploadedFiles(request, pdfDir, startIndex);

    if (files.length === 0) {
      return reply.code(400).send({ error: "No PDF files uploaded" });
    }

    await db.insert(bookFiles).values(
      files.map((f, i) => ({
        bookId,
        index: f.index,
        position: startPosition + i,
        filename: f.filename,
        pdfPath: f.pdfPath,
        status: (usesFullExtraction ? "pending" : "raw") as "pending" | "raw",
      })),
    );

    await quickAddJob({ connectionString }, "rawExtract", { bookId }, { maxAttempts: 1 });
    if (usesFullExtraction) {
      await db.update(books).set({ status: "pending", error: null, updatedAt: new Date() }).where(eq(books.id, bookId));
      await quickAddJob({ connectionString }, "extract", { bookId }, { maxAttempts: 1, jobKey: `extract:${bookId}`, jobKeyMode: "replace" });
    } else {
      await quickAddJob({ connectionString }, "ocrTextLayer", { bookId }, { maxAttempts: 1 });
    }

    const [updated] = await db.select().from(books).where(eq(books.id, bookId));
    return reply.send(updated);
  });

  // Reference recordings for Pocket TTS voice cloning: any container ffmpeg can decode.
  fastify.post("/upload/pocket-voice", { config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (request, reply) => {
    await mkdir(tmpDir, { recursive: true });
    const scratchPath = path.join(tmpDir, `pocket-voice-${randomUUID()}`);

    let name = "";
    let consented = false;
    let received = false;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        await pipeline(part.file, createWriteStream(scratchPath));
        received = true;
      } else if (part.fieldname === "name") {
        name = String((part as any).value ?? "");
      } else if (part.fieldname === "consent") {
        consented = String((part as any).value) === "true";
      }
    }

    try {
      if (!received) return reply.code(400).send({ error: "No audio uploaded" });
      if (!consented) {
        return reply.code(400).send({
          error: "Kyutai's terms prohibit cloning a voice without the speaker's consent — confirm you have it",
        });
      }
      return reply.send(await createCustomPocketVoice(scratchPath, name));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Voice import failed" });
    } finally {
      await rm(scratchPath, { force: true });
    }
  });
}
