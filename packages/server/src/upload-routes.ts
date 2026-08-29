import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { books, bookFiles, folders, type NoteJob } from "./schema.ts";
import { eq, and, desc } from "drizzle-orm";
import { profileIdFromHeader } from "./trpc.ts";
import { tmpDir, uploadsDir } from "./lib/paths.ts";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { quickAddJob } from "graphile-worker";
import { rm } from "node:fs/promises";
import { createCustomPocketVoice } from "./lib/pocket-voices.ts";

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
      const safeName = `${String(idx).padStart(2, "0")}_${part.filename}`;
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
  fastify.post("/upload", async (request, reply) => {
    const bookId = randomUUID();
    const pdfDir = path.join(uploadsDir, bookId);
    await mkdir(pdfDir, { recursive: true });

    const { files, fields } = await saveUploadedFiles(request, pdfDir, 0);

    const [firstFile] = files;
    if (!firstFile) {
      return reply.code(400).send({ error: "No PDF files uploaded" });
    }

    const note = parseNoteRequest(fields);
    if (note && "error" in note) {
      return reply.code(400).send({ error: note.error });
    }

    const title = fields.title
      || firstFile.filename.replace(/\.pdf$/i, "").replace(/[_-]/g, " ");
    const voice = fields.voice ?? "kokoro:af_heart";
    const { parseTtsVoice } = await import("./lib/tts.ts");
    parseTtsVoice(voice);
    const speed = parseFloat(fields.speed ?? "1.0");
    const forceOcr = fields.forceOcr === "true";
    const llmChapterDetection = fields.llmChapterDetection === "true";
    const chapterModel = fields.chapterModel?.trim().slice(0, 64) || null;
    const skipSynthesis = fields.skipSynthesis === "true";
    const fullExtract = fields.fullExtract === "true";

    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);
    // routes/books.ts bounds this with z.string().max(8), which rejects. Truncating here instead
    // would store "portugue" for "portuguese" — a code matching no voice and no option.
    const language = fields.language?.trim() || null;
    if (language && language.length > 8) {
      return reply.code(400).send({ error: "language must be at most 8 characters" });
    }
    const folderId = fields.folderId || null;
    if (folderId) {
      const [folder] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, folderId), eq(folders.profileId, profileId)));
      if (!folder) return reply.code(400).send({ error: "Folder not found" });
    }

    const now = new Date().toISOString();
    const noteJob: NoteJob | undefined = note
      ? { status: "queued", prompt: note.prompt, model: note.model, createdAt: now, updatedAt: now }
      : undefined;

    const [book] = await db
      .insert(books)
      .values({
        id: bookId,
        title,
        filename: firstFile.filename,
        pdfPath: firstFile.pdfPath,
        voice,
        speed,
        forceOcr,
        llmChapterDetection,
        chapterModel,
        skipSynthesis,
        language,
        folderId,
        profileId,
        ...(noteJob ? { noteJob } : {}),
      })
      .returning();

    await db.insert(bookFiles).values(
      files.map((f) => ({
        bookId,
        index: f.index,
        filename: f.filename,
        pdfPath: f.pdfPath,
        skipSynthesis,
        status: (fullExtract ? "pending" : "raw") as "pending" | "raw",
      })),
    );

    await quickAddJob(
      { connectionString },
      "rawExtract",
      { bookId, ...(note ? { note } : {}) },
      { maxAttempts: 1 },
    );
    if (fullExtract) {
      await quickAddJob({ connectionString }, "extract", { bookId }, { maxAttempts: 1 });
    }

    return reply.send(book);
  });

  fastify.post("/upload/:bookId", async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    if (!book) {
      return reply.code(404).send({ error: "Book not found" });
    }
    if (book.kind !== "pdf") {
      return reply.code(400).send({ error: "Cannot add PDF files to a synthetic book" });
    }
    const pdfDir = path.join(uploadsDir, bookId);
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
    const lastFile = await db
      .select({ index: bookFiles.index })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, bookId))
      .orderBy(desc(bookFiles.index))
      .limit(1);
    const startIndex = lastFile[0] ? lastFile[0].index + 1 : 0;

    const { files } = await saveUploadedFiles(request, pdfDir, startIndex);

    if (files.length === 0) {
      return reply.code(400).send({ error: "No PDF files uploaded" });
    }

    await db.insert(bookFiles).values(
      files.map((f) => ({
        bookId,
        index: f.index,
        filename: f.filename,
        pdfPath: f.pdfPath,
        status: (usesFullExtraction ? "pending" : "raw") as "pending" | "raw",
      })),
    );

    await quickAddJob({ connectionString }, "rawExtract", { bookId }, { maxAttempts: 1 });
    if (usesFullExtraction) {
      await db.update(books).set({ status: "pending", error: null, updatedAt: new Date() }).where(eq(books.id, bookId));
      await quickAddJob({ connectionString }, "extract", { bookId }, { maxAttempts: 1 });
    }

    const [updated] = await db.select().from(books).where(eq(books.id, bookId));
    return reply.send(updated);
  });

  // Reference recordings for Pocket TTS voice cloning: any container ffmpeg can decode.
  fastify.post("/upload/pocket-voice", async (request, reply) => {
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
