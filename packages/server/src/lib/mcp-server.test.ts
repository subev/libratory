import { describe, expect, it } from "vitest";
import { stageReached } from "./mcp-server.ts";

type Book = Parameters<typeof stageReached>[0];

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "b", title: "t", author: null, kind: "pdf", status: "done", error: null, voice: "kokoro:af_heart", speed: 1,
    language: null, folderId: null, totalWords: 0, totalDurationMs: 0, outputPath: "/out/book.m4b", downloadUrl: "/download/b",
    assembleQueued: false, files: [{ index: 0, filename: "a.pdf", status: "done", hasRawText: true, rawWords: 10, error: null }],
    chapters: [{ id: "c", index: 0, title: "One", status: "done", selected: true, wordCount: 10, pageStart: 1, pageEnd: 2, durationMs: 1000, hasAudio: true, error: null }],
    assemblies: [], documents: [], createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as Book;
}

describe("stageReached", () => {
  it("does not take a stale M4B for the output while chapters are re-narrating", () => {
    const narrating = book({ chapters: [{ ...book().chapters[0]!, status: "synthesizing", hasAudio: false }] });
    expect(stageReached(narrating, "output")).toBeNull();
    expect(stageReached(narrating, "audio")).toBeNull();
    expect(stageReached(book({ assembleQueued: true }), "output")).toBeNull();
    expect(stageReached(book(), "output")).toEqual({ satisfied: true });
  });

  it("fails fast and waits for detection before calling chapters ready", () => {
    expect(stageReached(book({ status: "failed", error: "boom" }), "text")).toEqual({ satisfied: false, reason: "boom" });
    expect(stageReached(book({ status: "extracting" }), "chapters")).toBeNull();
    expect(stageReached(book({ chapters: [] }), "chapters")).toBeNull();
    expect(stageReached(book({ files: [{ ...book().files[0]!, hasRawText: false }] }), "text")).toBeNull();
  });
});
