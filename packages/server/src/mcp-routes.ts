import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./lib/mcp-server.ts";
import { isTrustedHost } from "./lib/cors.ts";
import { profileIdFromHeader } from "./trpc.ts";

// MCP over Streamable HTTP, stateless: every request builds its own server and transport, so a
// restarted app never strands a client on a session id. Add it to an agent with the plain URL,
// e.g. `claude mcp add --transport http libratory http://localhost:3034/mcp`.
export function registerMcpRoutes(fastify: FastifyInstance, trustedHosts: ReadonlySet<string>) {
  fastify.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      // No Origin to judge, unlike the browser routes — the Host header is the whole rebinding check.
      if (!isTrustedHost(request.headers.host, trustedHosts)) {
        return reply.code(403).send({ jsonrpc: "2.0", error: { code: -32000, message: "Host not allowed" }, id: null });
      }
      const server = createMcpServer(profileIdFromHeader(request.headers["x-profile-id"]));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.hijack();
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  });
}
