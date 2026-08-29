import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { isUuid } from "./lib/uuid.ts";
import { profileIdFromHeader } from "./trpc.ts";
import {
  apiBookStatus,
  appendApiChapters,
  appendChaptersInputSchema,
  createApiBook,
  createBookInputSchema,
} from "./lib/api-books.ts";

// External JSON API for scripts and other projects (see docs/synthetic-books-api.md).
// Plain HTTP because tRPC clients are impractical outside this repo.
export function registerApiRoutes(fastify: FastifyInstance) {
  const handleError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "Invalid request body", issues: err.issues });
    }
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  };

  fastify.post("/api/books", async (request, reply) => {
    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);
    try {
      const input = createBookInputSchema.parse(request.body);
      const { book, chapters } = await createApiBook(input, profileId);
      return reply.code(201).send({ id: book.id, title: book.title, chapters });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  fastify.post("/api/books/:bookId/chapters", async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    if (!isUuid(bookId)) {
      return reply.code(400).send({ error: "Invalid book id" });
    }
    try {
      const input = appendChaptersInputSchema.parse(request.body);
      const result = await appendApiChapters(bookId, input);
      if (!result) return reply.code(404).send({ error: "Book not found" });
      return reply.code(201).send({ id: result.book.id, title: result.book.title, chapters: result.chapters });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  fastify.get("/api/books/:bookId", async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    if (!isUuid(bookId)) {
      return reply.code(400).send({ error: "Invalid book id" });
    }
    const status = await apiBookStatus(bookId);
    if (!status) return reply.code(404).send({ error: "Book not found" });
    return reply.send(status);
  });
}
