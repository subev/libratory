import { env } from "./env.ts";
import Fastify, { type FastifyRequest } from "fastify";
import cors, { type FastifyCorsOptions } from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { appRouter } from "./router.ts";
import { createContext } from "./trpc.ts";
import { startWorker, stopWorker } from "./workers/setup.ts";
import { registerChapterReaderRoute, type ChapterReaderLookupResult } from "./lib/chapter-reader-route.ts";
import { registerReaderRoutes } from "./lib/reader-routes.ts";
import { registerUploadRoutes } from "./upload-routes.ts";
import { registerChatRoutes } from "./chat-routes.ts";
import { registerTranslationStreamRoutes } from "./translation-stream-routes.ts";
import { registerApiRoutes } from "./api-routes.ts";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { registerScriptRunRoutes } from "./script-run-routes.ts";
import { ensureDataDirs, outputDir, previewsDir } from "./lib/paths.ts";
import { isAllowedOrigin, parseTrustedHosts } from "./lib/cors.ts";
import { registerSpaFallback } from "./lib/spa-fallback.ts";
import { db } from "./db.ts";
import { books, bookFiles, assemblies, documents, chapters, chapterVariants } from "./schema.ts";
import { eq } from "drizzle-orm";
import path from "node:path";
import { access, readdir, unlink } from "node:fs/promises";
import { createFastifyOptions } from "./fastify-config.ts";

const { PORT } = env;

// Changing any preview sentence re-keys every cached file; without this they would sit in the
// previews dir forever, unreadable and uncollected. Also clears WAV/TXT left by a failed run.
async function sweepStalePreviews() {
  const { PREVIEW_TEXT_VERSION } = await import("./lib/tts.ts");
  const suffix = `-${PREVIEW_TEXT_VERSION}.m4a`;
  const names = await readdir(previewsDir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => !name.endsWith(suffix))
      .map((name) => unlink(path.join(previewsDir, name)).catch(() => {})),
  );
}

async function main() {
  await ensureDataDirs();
  await sweepStalePreviews();

  const fastify = Fastify(createFastifyOptions());

  const trustedHosts = parseTrustedHosts(env.TRUSTED_HOSTS);
  await fastify.register(cors, () => (req: FastifyRequest, callback: (error: Error | null, options: FastifyCorsOptions) => void) => {
    callback(null, { origin: isAllowedOrigin(req.headers.origin, req.headers.host, trustedHosts) });
  });
  await fastify.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

  await fastify.register(fastifyStatic, {
    root: outputDir,
    prefix: "/files/",
  });

  // In development Vite serves the UI on its own port and proxies here. A packaged app has no
  // Vite, so the same server hands out the built bundle — and only if it was built, which is why
  // this is conditional rather than a hard dependency on `pnpm build` having run.
  const webDir = env.WEB_DIR;
  if (existsSync(path.join(webDir, "index.html"))) {
    await fastify.register(fastifyStatic, { root: webDir, prefix: "/", decorateReply: false });
    registerSpaFallback(fastify, webDir);
  }

  await fastify.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: { router: appRouter, createContext },
  });

  // What the desktop launcher waits for. Probing a business route instead meant renaming a router
  // would present as "the server did not start", with the real reason nowhere.
  fastify.get("/health", async () => ({ ok: true }));

  registerUploadRoutes(fastify);
  registerChatRoutes(fastify);
  registerTranslationStreamRoutes(fastify);
  registerApiRoutes(fastify);
  registerScriptRunRoutes(fastify);

  // Names what the browser saves from extensionless audio URLs (e.g. the <audio>
  // player's own download menu, which ignores the <a download> attribute)
  const contentDisposition = (type: "inline" | "attachment", filename: string): string => {
    const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    return `${type}; filename="${fallback}"; filename*=UTF-8''${utf8}`;
  };

  fastify.get("/pdf/:fileId", async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const [file] = await db.select().from(bookFiles).where(eq(bookFiles.id, fileId));
    if (!file) {
      return reply.code(404).send({ error: "File not found" });
    }
    return reply.type("application/pdf").sendFile(path.basename(file.pdfPath), path.dirname(file.pdfPath));
  });

  // Books uploaded before book_files existed have their PDF on the book row
  fastify.get("/pdf/book/:bookId", async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    if (!book?.pdfPath) {
      return reply.code(404).send({ error: "File not found" });
    }
    return reply.type("application/pdf").sendFile(path.basename(book.pdfPath), path.dirname(book.pdfPath));
  });

  fastify.get("/download/:bookId", async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const [book] = await db.select().from(books).where(eq(books.id, bookId));

    if (!book?.outputPath) {
      return reply.code(404).send({ error: "Book not found or not ready" });
    }

    return reply
      .header("content-disposition", contentDisposition("attachment", path.basename(book.outputPath)))
      .sendFile(path.relative(outputDir, book.outputPath), outputDir);
  });

  fastify.get("/download/assembly/:assemblyId", async (request, reply) => {
    const { assemblyId } = request.params as { assemblyId: string };
    const [assembly] = await db.select().from(assemblies).where(eq(assemblies.id, assemblyId));

    if (!assembly?.outputPath) {
      return reply.code(404).send({ error: "Assembly not found" });
    }

    return reply
      .header("content-disposition", contentDisposition("attachment", path.basename(assembly.outputPath)))
      .sendFile(path.relative(outputDir, assembly.outputPath), outputDir);
  });

  fastify.get("/download/document/:documentId", async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const [document] = await db.select().from(documents).where(eq(documents.id, documentId));

    if (!document?.outputPath) {
      return reply.code(404).send({ error: "Document not found" });
    }

    const mimeType = document.format === "pdf" ? "application/pdf" : "application/epub+zip";
    return reply.type(mimeType).sendFile(path.relative(outputDir, document.outputPath), outputDir);
  });

  fastify.get("/audio/chapter/:chapterId", async (request, reply) => {
    const { chapterId } = request.params as { chapterId: string };
    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId));

    if (!chapter?.audioPath) {
      return reply.code(404).send({ error: "Chapter audio not found" });
    }

    const filename = `${chapter.index + 1} ${chapter.title}${path.extname(chapter.audioPath)}`.replace(/[\\/]/g, "-");
    return reply
      .header("content-disposition", contentDisposition("inline", filename))
      .sendFile(path.relative(outputDir, chapter.audioPath), outputDir);
  });

  fastify.get("/audio/translation/:translationId", async (request, reply) => {
    const { translationId } = request.params as { translationId: string };
    const [row] = await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId));

    if (!row?.audioPath) {
      return reply.code(404).send({ error: "Translation audio not found" });
    }

    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, row.chapterId));
    const filename = chapter
      ? `${chapter.index + 1} ${row.title ?? chapter.title} (${row.label ?? row.key})${path.extname(row.audioPath)}`.replace(/[\\/]/g, "-")
      : path.basename(row.audioPath);
    return reply
      .header("content-disposition", contentDisposition("inline", filename))
      .sendFile(path.relative(outputDir, row.audioPath), outputDir);
  });

  fastify.get("/audio/assembly/:assemblyId", async (request, reply) => {
    const { assemblyId } = request.params as { assemblyId: string };
    const [assembly] = await db.select().from(assemblies).where(eq(assemblies.id, assemblyId));

    if (!assembly?.outputPath) {
      return reply.code(404).send({ error: "Assembly not found" });
    }

    return reply
      .header("content-disposition", contentDisposition("inline", path.basename(assembly.outputPath)))
      .sendFile(path.relative(outputDir, assembly.outputPath), outputDir);
  });

  registerReaderRoutes(fastify);

  registerChapterReaderRoute(fastify, async (chapterId): Promise<ChapterReaderLookupResult> => {
    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
    if (!chapter) {
      return { kind: "not-found", message: "Chapter not found" };
    }

    const [book] = await db.select().from(books).where(eq(books.id, chapter.bookId));
    if (!book) {
      return { kind: "not-found", message: "Book not found" };
    }

    if (!Array.isArray(chapter.sourceBlocks)) {
      return { kind: "not-found", message: "Chapter source blocks not found" };
    }

    return {
      kind: "ok",
      chapter: {
        bookTitle: book.title,
        chapterTitle: chapter.title,
        pageStart: chapter.pageStart,
        pageEnd: chapter.pageEnd,
        sourceBlocks: chapter.sourceBlocks,
      },
    };
  });

  // Keyed by voice: a second request for a preview already being synthesized waits on the same run
  // rather than being told to come back later, so the client needs no polling protocol.
  const previewGenerating = new Map<string, Promise<void>>();

  fastify.get("/preview/:voiceId", async (request, reply) => {
    const { voiceId } = request.params as { voiceId: string };

    const { parseTtsVoice, previewFileBase } = await import("./lib/tts.ts");
    try {
      parseTtsVoice(voiceId);
    } catch {
      return reply.code(400).send({ error: "Invalid voice ID" });
    }
    const previewKey = previewFileBase(voiceId);

    const m4aPath = path.join(previewsDir, `${previewKey}.m4a`);

    try {
      await access(m4aPath);
      return reply.sendFile(`${previewKey}.m4a`, previewsDir);
    } catch {}

    let generating = previewGenerating.get(voiceId);
    if (!generating) {
      generating = (async () => {
        const { synthesize, getPreviewTextForVoice } = await import("./lib/tts.ts");
        const { encodeToM4a } = await import("./lib/ffmpeg.ts");
        const wavPath = path.join(previewsDir, `${previewKey}.wav`);

        await synthesize({
          inputText: await getPreviewTextForVoice(voiceId),
          outputPath: wavPath,
          voice: voiceId,
          speed: 1.0,
        });

        await encodeToM4a(wavPath, m4aPath);
        await Promise.all([
          unlink(wavPath).catch(() => {}),
          unlink(wavPath.replace(/\.wav$/, ".txt")).catch(() => {}),
        ]);
      })();
      previewGenerating.set(voiceId, generating);
      // Settled either way, the slot must free; the catch keeps the rejection from going unhandled
      // here, since each waiting request handles it on its own await below.
      void generating.catch(() => {}).finally(() => previewGenerating.delete(voiceId));
    }

    try {
      await generating;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `Preview generation failed: ${message}` });
    }

    return reply.sendFile(`${previewKey}.m4a`, previewsDir);
  });

  // A packaged app has no drizzle-kit and nobody to run `pnpm db:migrate`, so an install on a
  // machine that has never seen this project comes up against an empty database. Applying here is
  // idempotent — drizzle skips anything already recorded in __drizzle_migrations.
  await migrate(db, { migrationsFolder: env.MIGRATIONS_DIR });

  await startWorker();

  await fastify.listen({ port: PORT, host: env.HOST });
  console.log(`Server running on http://localhost:${PORT}`);

  const shutdown = async () => {
    await stopWorker();
    await fastify.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
