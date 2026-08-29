import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Fastify's default handler sends error.message, and a failed Drizzle query carries the full
// column list of the table it ran against — a malformed path param leaked the schema in a 500.
export function registerErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error({ err: error }, "request failed");

    const statusCode = error.statusCode ?? 500;
    return reply
      .code(statusCode)
      .send({ error: statusCode >= 500 ? "Internal Server Error" : error.message });
  });
}
