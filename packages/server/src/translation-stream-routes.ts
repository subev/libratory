import type { FastifyInstance } from "fastify";
import { db } from "./db.ts";
import { chapterVariants } from "./schema.ts";
import { eq } from "drizzle-orm";
import {
  liveTranslationState,
  subscribeTranslationLive,
  type TranslationLiveEvent,
} from "./lib/translate-live.ts";
import { isUuid } from "./lib/uuid.ts";

const HEARTBEAT_MS = 15_000;

export function registerTranslationStreamRoutes(fastify: FastifyInstance) {
  fastify.get("/translations/:translationId/stream", async (request, reply) => {
    const { translationId } = request.params as { translationId: string };
    if (!isUuid(translationId)) return reply.code(400).send({ error: "Invalid translation id" });
    const [row] = await db.select().from(chapterVariants).where(eq(chapterVariants.id, translationId));
    if (!row) return reply.code(404).send({ error: "Translation not found" });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: TranslationLiveEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    // No await between snapshot and subscribe, so no delta can slip through the gap.
    const live = liveTranslationState(translationId);
    send({ type: "snapshot", text: live?.text ?? row.text ?? "" });
    if (live?.thinking) send({ type: "thinking", text: live.thinking });
    if (row.status !== "pending" && row.status !== "translating") {
      send({ type: "status", status: row.status as "done" | "failed" | "suspended", ...(row.error ? { error: row.error } : {}) });
      res.end();
      return;
    }

    const heartbeat = setInterval(() => res.write(":\n\n"), HEARTBEAT_MS);
    const unsubscribe = subscribeTranslationLive(translationId, (event) => {
      send(event);
      if (event.type === "status") {
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      }
    });
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
