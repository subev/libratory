import type { FastifyInstance } from "fastify";
import { profileIdFromHeader } from "./trpc.ts";
import { isUuid } from "./lib/uuid.ts";
import { UPLOAD_RATE_LIMIT } from "./lib/request-limits.ts";
import { removeStaged, stageUpload, StagedUploadError } from "./lib/staged-files.ts";

// The assistant panel's drop target. One PDF per request, answered with the `staged:` reference the
// model is given; the file itself never becomes a path the browser or the model sees.
export function registerStagedRoutes(fastify: FastifyInstance) {
  fastify.post("/upload/staged", { config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (request, reply) => {
    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);
    const part = await request.file();
    if (!part) return reply.status(400).send({ error: "No file" });
    try {
      const staged = await stageUpload({ profileId, filename: part.filename, stream: part.file });
      return reply.send(staged);
    } catch (err) {
      if (err instanceof StagedUploadError) return reply.status(err.status).send({ error: err.message });
      throw err;
    }
  });

  fastify.delete("/upload/staged/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.status(400).send({ error: "Bad id" });
    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);
    const removed = await removeStaged(id, profileId);
    return reply.status(removed ? 200 : 404).send({ removed });
  });
}
