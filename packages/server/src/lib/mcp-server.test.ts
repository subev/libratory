import { describe, expect, it } from "vitest";
import { stageReached, summarizeBook } from "./mcp-server.ts";

type Book = Parameters<typeof stageReached>[0];

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "b", title: "t", author: null, kind: "pdf", status: "done", error: null, voice: "kokoro:af_heart", speed: 1,
    language: null, searchIndex: null, folderId: null, totalWords: 0, totalDurationMs: 0, outputPath: "/out/book.m4b", downloadUrl: "/download/b",
    assembleQueued: false, files: [{ index: 0, filename: "a.pdf", status: "done", hasRawText: true, rawWords: 10, error: null }],
    chapters: [{ id: "c", index: 0, title: "One", status: "done", selected: true, wordCount: 10, pageStart: 1, pageEnd: 2, durationMs: 1000, hasAudio: true, error: null }],
    assemblies: [], documents: [], variants: [], createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as Book;
}

const idle = { text: false, index: false };

function variant(overrides: Partial<Book["variants"][number]> = {}): Book["variants"][number] {
  return { key: "German", kind: "translation", label: null, chapters: { total: 1, done: 1, running: 0, failed: 0 }, error: null, failedAt: null, chapterIndexes: [0], withAudio: 0, narrating: 0, audioFailed: 0, audioError: null, audioFailedAt: null, ...overrides };
}

const now = Date.parse("2026-09-30T12:00:00Z");
const minutesAgo = (m: number) => new Date(now - m * 60_000);

describe("stageReached", () => {
  it("does not take a stale M4B for the output while chapters are re-narrating", () => {
    const narrating = book({ chapters: [{ ...book().chapters[0]!, status: "synthesizing", hasAudio: false }] });
    expect(stageReached(narrating, "output", idle)).toBeNull();
    expect(stageReached(narrating, "audio", idle)).toBeNull();
    const lane = book({ variants: [variant({ narrating: 1 })] });
    expect(stageReached(lane, "audio", idle)).toBeNull();
    expect(stageReached(lane, "output", idle)).toBeNull();
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

describe("stageReached for translations and exports", () => {
  it("reports a translation's failed narration instead of calling the audio ready", () => {
    const refused = book({ variants: [variant({ key: "Bulgarian", audioFailed: 1, audioError: "Cartesia is out of credits" })] });
    expect(stageReached(refused, "audio", idle)).toEqual({ satisfied: false, reason: "Bulgarian narration failed for 1 chapter: Cartesia is out of credits" });
    expect(stageReached(refused, "audio", idle, "Bulgarian")).toMatchObject({ satisfied: false });
    // Another lane's old failure does not speak for the one being waited on
    expect(stageReached(refused, "audio", idle, "German")).toMatchObject({ satisfied: false, reason: "No German version — translate_book makes one" });
    const both = book({ variants: [variant({ key: "Bulgarian", audioFailed: 1 }), variant({ withAudio: 1 })] });
    expect(stageReached(both, "audio", idle, "German")).toEqual({ satisfied: true });
    expect(stageReached(book({ variants: [variant({ narrating: 1 })] }), "audio", idle, "German")).toBeNull();
  });

  it("does not fail a wait on another version's failure from long ago", () => {
    const old = book({ variants: [variant({ key: "Bulgarian", audioFailed: 1, audioError: "402", audioFailedAt: minutesAgo(60 * 24 * 30) })] });
    expect(stageReached(old, "audio", idle, undefined, now)).toEqual({
      satisfied: true,
      reason: "An older failure, not from this run: Bulgarian narration failed for 1 chapter at 2026-08-31T12:00:00.000Z: 402",
    });
    // Named, it is the lane being waited on, and its failure is the answer however old
    expect(stageReached(old, "audio", idle, "Bulgarian", now)).toMatchObject({ satisfied: false });
    const fresh = book({ variants: [variant({ key: "Bulgarian", audioFailed: 1, audioError: "402", audioFailedAt: minutesAgo(1) })] });
    expect(stageReached(fresh, "audio", idle, undefined, now)).toMatchObject({ satisfied: false, reason: expect.stringContaining("at 2026-09-30T11:59:00.000Z") });
  });

  it("waits for a translation to finish and names the one that failed", () => {
    expect(stageReached(book(), "translation", idle)).toEqual({ satisfied: false, reason: "No translation or rewrite — translate_book makes one" });
    const running = book({ variants: [variant({ chapters: { total: 2, done: 1, running: 1, failed: 0 } })] });
    expect(stageReached(running, "translation", idle)).toBeNull();
    expect(stageReached(running, "translation", idle, "German")).toBeNull();
    expect(stageReached(running, "translation", idle, "French")).toMatchObject({ satisfied: false, reason: "No French version — translate_book makes one" });
    expect(stageReached(book({ variants: [variant()] }), "translation", idle, "German")).toEqual({ satisfied: true });
    const failed = book({ variants: [variant({ chapters: { total: 2, done: 1, running: 0, failed: 1 }, error: "context exceeded", failedAt: minutesAgo(2) })] });
    expect(stageReached(failed, "translation", idle, undefined, now)).toEqual({
      satisfied: false, reason: "German translation failed for 1 chapter at 2026-09-30T11:58:00.000Z: context exceeded",
    });
  });

  it("waits for pairs and links, and names what failed", () => {
    expect(stageReached(book(), "bilingual", { ...idle, bilingual: { running: 2, failed: [], active: [] } })).toBeNull();
    expect(stageReached(book(), "bilingual", { ...idle, bilingual: { running: 0, failed: [], active: [] } })).toEqual({ satisfied: true });
    expect(stageReached(book(), "bilingual", { ...idle, bilingual: { running: 0, failed: [], active: [] } })).toEqual({ satisfied: true });
    const failed = (at: Date) => ({ ...idle, bilingual: { running: 0, failed: [{ text: "Letter 1 (links): model refused", at }], active: [] } });
    expect(stageReached(book(), "bilingual", failed(minutesAgo(5)), undefined, now))
      .toEqual({ satisfied: false, reason: "Preparation failed: Letter 1 (links): model refused" });
    // A chapter that failed yesterday — or was interrupted by a restart — does not hold up today's run
    expect(stageReached(book(), "bilingual", failed(minutesAgo(60 * 24)), undefined, now))
      .toEqual({ satisfied: true, reason: "An older failure, not from this run: Letter 1 (links): model refused" });
  });

  it("refuses to wait on the preparation of a version that does not exist", () => {
    const quiet = { ...idle, bilingual: { running: 0, failed: [], active: [] } };
    expect(stageReached(book({ variants: [variant()] }), "bilingual", quiet, "Germna")).toEqual({ satisfied: false, reason: "No Germna version — translate_book makes one" });
    expect(stageReached(book({ variants: [variant()] }), "bilingual", quiet, "German")).toEqual({ satisfied: true });
  });

  it("waits for a queued or running export, not for the M4B", () => {
    expect(stageReached(book({ outputPath: null }), "document", { ...idle, document: true })).toBeNull();
    expect(stageReached(book({ status: "assembling" }), "document", idle)).toBeNull();
    expect(stageReached(book({ outputPath: null }), "document", { ...idle, document: false })).toEqual({ satisfied: true });
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

  it("counts a lane's failed narration and leaves the per-chapter indexes to get_book", () => {
    const summary = summarizeBook(book({ variants: [variant({ audioFailed: 1, audioError: "boom", chapterIndexes: [0, 3] })] }));
    expect(summary.variants).toEqual([expect.objectContaining({ audioFailed: 1, audioError: "boom" })]);
    expect(summary.variants[0]).not.toHaveProperty("chapterIndexes");
  });
});
