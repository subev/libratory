import { describe, expect, it } from "vitest";
import { stageReached, summarizeBook } from "./mcp-server.ts";

type Book = Parameters<typeof stageReached>[0];

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "b", title: "t", author: null, kind: "pdf", status: "done", error: null, voice: "kokoro:af_heart", speed: 1,
    language: null, searchIndex: null, folderId: null, totalWords: 0, totalDurationMs: 0, outputPath: "/out/book.m4b", downloadUrl: "/download/b",
    assembleQueued: false, files: [{ index: 0, filename: "a.pdf", status: "done", hasRawText: true, rawWords: 10, error: null }],
    chapters: [{ id: "c", index: 0, title: "One", status: "done", selected: true, wordCount: 10, pageStart: 1, pageEnd: 2, durationMs: 1000, hasAudio: true, error: null }],
    assemblies: [], documents: [], createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as Book;
}

const idle = { text: false, index: false };

describe("stageReached", () => {
  it("does not take a stale M4B for the output while chapters are re-narrating", () => {
    const narrating = book({ chapters: [{ ...book().chapters[0]!, status: "synthesizing", hasAudio: false }] });
    expect(stageReached(narrating, "output", idle)).toBeNull();
    expect(stageReached(narrating, "audio", idle)).toBeNull();
    expect(stageReached(book({ assembleQueued: true }), "output", idle)).toBeNull();
    expect(stageReached(book(), "output", idle)).toEqual({ satisfied: true });
  });

  it("fails fast and waits for detection before calling chapters ready", () => {
    expect(stageReached(book({ status: "failed", error: "boom" }), "text", idle)).toEqual({ satisfied: false, reason: "boom" });
    expect(stageReached(book({ status: "extracting" }), "chapters", idle)).toBeNull();
    expect(stageReached(book({ chapters: [] }), "chapters", idle)).toBeNull();
    expect(stageReached(book({ files: [{ ...book().files[0]!, hasRawText: false }] }), "text", { text: true, index: false })).toBeNull();
  });

  it("does not call the text ready while one file of several is still being read", () => {
    const scan = { ...book().files[0]!, index: 1, filename: "scan.pdf", status: "raw" as const, hasRawText: false, rawWords: null };
    const mixed = book({ status: "extracting", files: [book().files[0]!, scan] });
    expect(stageReached(mixed, "text", idle)).toBeNull();
    // OCR is queued but has not started: the book looks idle, the queue says otherwise
    expect(stageReached(book({ status: "pending", files: [book().files[0]!, scan] }), "text", { text: true, index: false })).toBeNull();
    expect(stageReached(book({ status: "pending", files: [book().files[0]!, scan] }), "text", idle)).toEqual({ satisfied: true });
  });

  it("hands over the raw text while the thorough page read is still running", () => {
    const reading = book({ status: "extracting", files: [{ ...book().files[0]!, status: "extracting" }], searchIndex: { status: "done", progress: null, error: null } });
    expect(stageReached(reading, "text", idle)).toEqual({ satisfied: true });
    // ...but that run reindexes when it ends, so the index is not yet the whole story
    expect(stageReached(reading, "searchable", idle)).toBeNull();
  });

  it("ends the wait when nothing is left to run and no file has text", () => {
    const empty = book({ status: "pending", files: [{ ...book().files[0]!, hasRawText: false }] });
    expect(stageReached(empty, "text", idle)).toMatchObject({ satisfied: false });
  });

  it("takes a written book's chapters for its text", () => {
    expect(stageReached(book({ kind: "api", files: [] }), "text", idle)).toEqual({ satisfied: true });
    expect(stageReached(book({ kind: "api", files: [], chapters: [] }), "text", idle)).toBeNull();
  });

  it("is searchable only once the index has caught up with the text", () => {
    const indexed = book({ searchIndex: { status: "done", progress: null, error: null } });
    expect(stageReached(indexed, "searchable", idle)).toEqual({ satisfied: true });
    // The index said done before OCR added a file's text, and the reindex is still queued
    expect(stageReached(indexed, "searchable", { text: false, index: true })).toBeNull();
    expect(stageReached(book({ ...indexed, status: "extracting" }), "searchable", idle)).toBeNull();
    expect(stageReached(book(), "searchable", idle)).toBeNull();
    expect(stageReached(book({ searchIndex: { status: "waiting", progress: null, error: null } }), "searchable", idle)).toMatchObject({ satisfied: true });
    expect(stageReached(book({ searchIndex: { status: "failed", progress: null, error: "no model" } }), "searchable", idle)).toEqual({ satisfied: false, reason: "no model" });
  });
});

describe("summarizeBook", () => {
  it("counts chapters and names only the ones that failed", () => {
    const one = book().chapters[0]!;
    const summary = summarizeBook(book({
      chapters: [one, { ...one, id: "d", index: 1, status: "failed", hasAudio: false, error: "voice missing" }, { ...one, id: "e", index: 2, selected: false }],
      files: [book().files[0]!, { ...book().files[0]!, index: 1, filename: "scan.pdf", hasRawText: false }],
    }));
    expect(summary.chapters).toEqual({
      total: 3, selected: 2, withAudio: 2, byStatus: { done: 2, failed: 1 },
      failed: [{ id: "d", index: 1, title: "One", error: "voice missing" }],
    });
    expect(summary.files).toMatchObject({ total: 2, withText: 1, withoutText: [{ index: 1, filename: "scan.pdf" }] });
    expect(JSON.stringify(summary)).not.toContain("pageStart");
  });
});
