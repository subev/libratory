import type { FastifyInstance } from "fastify";

import { renderChapterReaderHtml, type ChapterReaderSourceBlock } from "./chapter-reader.ts";
import { isUuid } from "./uuid.ts";

type ChapterReaderData = {
  bookTitle: string;
  chapterTitle: string;
  pageStart: number | null;
  pageEnd: number | null;
  sourceBlocks: ChapterReaderSourceBlock[];
};

export type ChapterReaderLookupResult =
  | { kind: "ok"; chapter: ChapterReaderData }
  | { kind: "not-found"; message: string };

export function registerChapterReaderRoute(
  fastify: FastifyInstance,
  lookupChapter: (chapterId: string) => Promise<ChapterReaderLookupResult>,
) {
  fastify.get("/read/chapter/:chapterId", async (request, reply) => {
    const { chapterId } = request.params as { chapterId: string };
    if (!isUuid(chapterId)) return reply.code(400).send({ error: "Invalid chapter id" });
    const result = await lookupChapter(chapterId);

    if (result.kind === "not-found") {
      return reply.code(404).send({ error: result.message });
    }

    const html = renderChapterReaderHtml(result.chapter);
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
