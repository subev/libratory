import path from "node:path";
import type { FastifyInstance } from "fastify";

// The client routes in packages/web/src/main.tsx, and nothing else. An allow-list deliberately:
// forget to add one here and it 404s the first time anyone opens it, which you find in a minute.
// The rule this replaces was "a GET with no file extension is a client route" — and /pdf/:id and
// /audio/chapter/:id have no extension, so when a renamed checkout left every stored path pointing
// at a directory that no longer existed, the server answered pdf.js an index.html with a 200 and
// said nothing. Whatever drifts here, it must never be able to fail in that direction again.
const CLIENT_ROUTES = [
  /^\/$/,
  /^\/open$/,
  /^\/phone$/,
  /^\/folders\/[^/]+$/,
  /^\/books\/[^/]+$/,
  /^\/books\/[^/]+\/read$/,
  /^\/books\/[^/]+\/ocr$/,
];

export function isClientRoute(method: string, url: string): boolean {
  if (method !== "GET") return false;
  const pathname = url.split(/[?#]/)[0] ?? "";
  if (path.extname(pathname)) return false;
  return CLIENT_ROUTES.some((route) => route.test(pathname));
}

// Reached both by a URL matching no route at all and by a route whose own file has gone missing —
// @fastify/static answers a failed sendFile by calling the not-found handler.
export function registerSpaFallback(fastify: FastifyInstance, webDir: string) {
  fastify.setNotFoundHandler((request, reply) => {
    if (!isClientRoute(request.method, request.url)) {
      return reply.code(404).send({ error: "Not Found" });
    }
    return reply.type("text/html").sendFile("index.html", webDir);
  });
}

// Development: Vite owns the UI on its own port, and the built bundle in web/dist is whatever the
// last `pnpm build` left — a client days older than the server it would call, crashing on the first
// response whose shape moved. A browser that lands on the API port is sent to Vite instead.
export function registerDevRedirect(fastify: FastifyInstance, webOrigin: string) {
  fastify.setNotFoundHandler((request, reply) => {
    if (!isClientRoute(request.method, request.url)) {
      return reply.code(404).send({ error: "Not Found" });
    }
    return reply.redirect(`${webOrigin}${request.url}`, 302);
  });
}
