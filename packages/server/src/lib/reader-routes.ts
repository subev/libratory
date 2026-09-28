import { buildBilingualDocument } from "./bilingual-document.ts";
import type { FastifyInstance } from "fastify";

import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { chapterVariants } from "../schema.ts";
import { bookForReader, buildCues, buildManifest, buildText, buildVariantCues, chapterForReader } from "./reader-doc.ts";
import { isUuid } from "./uuid.ts";

export function registerReaderRoutes(fastify: FastifyInstance) {
  fastify.get("/read/bilingual/:variantId.json", async (request, reply) => {
    const { variantId } = request.params as { variantId: string };
    if (!isUuid(variantId)) return reply.code(400).send({ error: "Invalid translation id" });
    try {
      const doc = await buildBilingualDocument(variantId);
      return doc ? reply.header("Cache-Control", "no-store").send(doc) : reply.code(409).send({ error: "Pairing is missing or stale. Prepare the chapter again." });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Bilingual reading unavailable" });
    }
  });
  fastify.get("/read/book/:bookId/book.json", async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    if (!isUuid(bookId)) return reply.code(400).send({ error: "Invalid book id" });
    const book = await bookForReader(bookId);
    if (!book) return reply.code(404).send({ error: "Book not found" });

    return reply.send(await buildManifest(book));
  });

  fastify.get("/read/chapter/:chapterId/text.json", async (request, reply) => {
    const { chapterId } = request.params as { chapterId: string };
    if (!isUuid(chapterId)) return reply.code(400).send({ error: "Invalid chapter id" });
    const chapter = await chapterForReader(chapterId);
    if (!chapter) return reply.code(404).send({ error: "Chapter not found" });

    const text = buildText(chapter);
    if (!text) return reply.code(404).send({ error: "Chapter has no text" });

    return reply.send(text);
  });

  fastify.get("/read/chapter/:chapterId/cues.json", async (request, reply) => {
    const { chapterId } = request.params as { chapterId: string };
    if (!isUuid(chapterId)) return reply.code(400).send({ error: "Invalid chapter id" });
    const chapter = await chapterForReader(chapterId);
    if (!chapter) return reply.code(404).send({ error: "Chapter not found" });

    const cues = await buildCues(chapter);
    if (!cues) return reply.code(404).send({ error: "Chapter has no timing map yet" });

    return reply.send(cues);
  });

  // A translation's or rewrite's own recording, timed against its own text
  fastify.get("/read/variant/:variantId/cues.json", async (request, reply) => {
    const { variantId } = request.params as { variantId: string };
    if (!isUuid(variantId)) return reply.code(400).send({ error: "Invalid variant id" });
    const [variant] = await db.select().from(chapterVariants).where(eq(chapterVariants.id, variantId));
    if (!variant) return reply.code(404).send({ error: "Variant not found" });
    const cues = variant.audioStatus === "done" && variant.audioPath && variant.text.trim() ? await buildVariantCues(variant.audioPath, variant.text) : null;
    if (!cues) return reply.code(404).send({ error: "Variant has no timing map yet" });

    return reply.header("Cache-Control", "no-store").send(cues);
  });
}
