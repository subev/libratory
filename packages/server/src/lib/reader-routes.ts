import type { FastifyInstance } from "fastify";

import { bookForReader, buildCues, buildManifest, chapterForReader } from "./reader-doc.ts";
import { isUuid } from "./uuid.ts";

export function registerReaderRoutes(fastify: FastifyInstance) {
  fastify.get("/read/book/:bookId/book.json", async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    if (!isUuid(bookId)) return reply.code(400).send({ error: "Invalid book id" });
    const book = await bookForReader(bookId);
    if (!book) return reply.code(404).send({ error: "Book not found" });

    return reply.send(await buildManifest(book));
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
}
