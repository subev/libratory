import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { registerSpaFallback } from "./spa-fallback.ts";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp() {
  const webDir = await mkdtemp(path.join(tmpdir(), "spa-fallback-"));
  await writeFile(path.join(webDir, "index.html"), "<!doctype html><div id=root></div>");

  const app = Fastify();
  apps.push(app);
  // main.ts registers /files/ first, which is what decorates reply.sendFile for both.
  await app.register(fastifyStatic, { root: webDir, prefix: "/" });
  // The shape that failed: a real route whose stored file is gone. A missing file under a root
  // that exists is answered by the not-found handler, which is what used to hand back the shell;
  // a root that is gone too throws. Neither may ever come back as a page.
  app.get("/pdf/gone-file", (_request, reply) => reply.type("application/pdf").sendFile("gone.pdf", webDir));
  app.get("/pdf/gone-root", (_request, reply) => reply.type("application/pdf").sendFile("gone.pdf", path.join(webDir, "nowhere")));
  registerSpaFallback(app, webDir);
  await app.ready();
  return app;
}

describe("registerSpaFallback", () => {
  it("serves the shell for the routes the client owns", async () => {
    const app = await createApp();
    for (const url of ["/", "/open", "/chat", "/chat/c-1", "/folders/f-1", "/books/b-1", "/books/b-1/read"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-type"], url).toContain("text/html");
    }
  });

  it("404s a server path instead of answering it with the app", async () => {
    const app = await createApp();
    for (const url of ["/audio/chapter/c-1", "/read/book/b-1/book.json", "/api/books", "/health"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual({ error: "Not Found" });
    }
  });

  // The one that shipped: a renamed checkout left every stored path pointing at a directory that
  // no longer existed, and pdf.js was handed an index.html with a 200 for every page of every book.
  it("never answers a file request with the app, however the file is missing", async () => {
    const app = await createApp();
    for (const url of ["/pdf/gone-file", "/pdf/gone-root"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(response.headers["content-type"], url).not.toContain("text/html");
    }
  });

  it("does not answer a non-GET with the shell", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "POST", url: "/chat" });
    expect(response.statusCode).toBe(404);
  });

  it("leaves an unknown asset a 404 rather than a page that looks like it loaded", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: "/assets/gone.js" });
    expect(response.statusCode).toBe(404);
  });
});
