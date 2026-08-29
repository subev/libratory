import type { FastifyError, FastifyInstance } from "fastify";

// Fastify's default handler sends error.message, and a failed Drizzle query carries the full
// column list of the table it ran against — a malformed path param leaked the schema in a 500.
export function registerErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (statusCode >= 500) request.log.error({ err: error }, "request failed");
    else request.log.warn({ err: error, statusCode }, "request failed");

    return reply
      .code(statusCode)
      .send({ error: statusCode >= 500 ? "Internal Server Error" : error.message });
  });
}
