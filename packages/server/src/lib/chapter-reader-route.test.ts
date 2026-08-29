import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerChapterReaderRoute,
  type ChapterReaderLookupResult,
} from "./chapter-reader-route.ts";

const CHAPTER_ID = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(result: ChapterReaderLookupResult) {
  const app = Fastify();
  apps.push(app);

  registerChapterReaderRoute(app, async () => result);
  await app.ready();
  return app;
}

describe("registerChapterReaderRoute", () => {
  it("returns reader HTML for a chapter with source blocks", async () => {
    const app = await createApp({
      kind: "ok",
      chapter: {
        bookTitle: "Book",
        chapterTitle: "Chapter",
        pageStart: 2,
        pageEnd: 4,
        sourceBlocks: [{ type: "Text", text: "Hello world", page: 2, included: true }],
      },
    });

    const response = await app.inject({ method: "GET", url: `/read/chapter/${CHAPTER_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain('<h1 itemprop="headline">Chapter</h1>');
    expect(response.body).toContain("<p>Hello world</p>");
  });

  it("returns 404 when the chapter is missing", async () => {
    const app = await createApp({ kind: "not-found", message: "Chapter not found" });

    const response = await app.inject({ method: "GET", url: `/read/chapter/${CHAPTER_ID}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Chapter not found" });
  });

  it("returns 404 when source blocks are unavailable", async () => {
    const app = await createApp({ kind: "not-found", message: "Chapter source blocks not found" });

    const response = await app.inject({ method: "GET", url: `/read/chapter/${CHAPTER_ID}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Chapter source blocks not found" });
  });

  it("rejects an id that is not a uuid before looking the chapter up", async () => {
    const app = await createApp({ kind: "not-found", message: "Chapter not found" });

    const response = await app.inject({ method: "GET", url: "/read/chapter/not-a-uuid" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid chapter id" });
  });
});
