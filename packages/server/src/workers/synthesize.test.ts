import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdir, writeFile, readdir, rm } from "node:fs/promises";

import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, chapters } from "../schema.ts";

vi.mock("../lib/tts.ts", () => {
  class TtsAbortedError extends Error {
    constructor() {
      super("TTS synthesis aborted");
      this.name = "TtsAbortedError";
    }
  }

  return {
    synthesize: vi.fn(),
    TtsAbortedError,
    voiceSupportsSpeed: (voice: string) => voice.startsWith("kokoro:"),
  };
});

vi.mock("../lib/ffmpeg.ts", () => ({
  encodeToM4a: vi.fn(async () => {}),
}));

vi.mock("../lib/paths.ts", () => ({
  bookOutputDir: (bookId: string) => `/tmp/test-output-${bookId}`,
}));

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("music-metadata", () => ({
  parseFile: vi.fn(async () => ({ format: { duration: 12.4 } })),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { synthesize as synthesizeAudio, TtsAbortedError } from "../lib/tts.ts";
import { synthesize as synthesizeWorker } from "./synthesize.ts";

const mockSynthesizeAudio = vi.mocked(synthesizeAudio);

describe("synthesize worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockSynthesizeAudio.mockReset();
  });

  it("passes the stored voice to the generic dispatcher and marks the chapter done", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const chapterId = crypto.randomUUID();

    await db.insert(books).values({
      id: bookId,
      title: "Bulgarian Book",
      filename: "book.pdf",
      pdfPath: "/tmp/book.pdf",
      voice: "bg-mlx:narrator",
      speed: 1.0,
    });

    await db.insert(chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Chapter 1",
      rawText: "Сутринта беше тиха и светла.",
      cleanText: "Сутринта беше тиха и светла.",
    });

    mockSynthesizeAudio.mockImplementation(async ({ onProgress }) => {
      await onProgress?.(1, 2);
      await onProgress?.(2, 2);
    });

    await synthesizeWorker({ bookId, chapterId }, { addJob: vi.fn() } as never);

    expect(mockSynthesizeAudio).toHaveBeenCalledWith(expect.objectContaining({
      voice: "bg-mlx:narrator",
      speed: 1.0,
      chunkPreviewDir: `/tmp/test-output-${bookId}/chunks/ch000`,
      chunkPreviewUrlBase: `/files/${bookId}/chunks/ch000`,
    }));

    const chapter = row(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(chapter.status).toBe("done");
    expect(chapter.progress).toBeNull();
    expect(chapter.audioPath).toContain("ch000.m4a");
    expect(chapter.durationMs).toBe(12400);
    expect(chapter.synthesizedWith).toEqual({ voice: "bg-mlx:narrator", speed: null });
  });

  it("never queues an assembly when the last chapter lands", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const chapterId = crypto.randomUUID();
    const addJob = vi.fn();

    await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });
    await db.insert(chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Chapter 1",
      rawText: "One.",
      cleanText: "One.",
    });

    mockSynthesizeAudio.mockImplementation(async () => {});

    await synthesizeWorker({ bookId, chapterId }, { addJob } as never);

    const chapter = row(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(chapter.status).toBe("done");
    expect(addJob).not.toHaveBeenCalled();
  });

  it("resume keeps existing chunk previews and drops only the last (possibly partial) one", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const chapterId = crypto.randomUUID();

    await db.insert(books).values({
      id: bookId,
      title: "Bulgarian Book",
      filename: "book.pdf",
      pdfPath: "/tmp/book.pdf",
      voice: "bg-mlx:narrator",
      speed: 1.0,
    });
    await db.insert(chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Chapter 1",
      rawText: "Сутринта беше тиха и светла.",
      cleanText: "Сутринта беше тиха и светла.",
    });

    const chunkDir = `/tmp/test-output-${bookId}/chunks/ch000`;
    await mkdir(chunkDir, { recursive: true });
    await writeFile(`${chunkDir}/chunk-001.wav`, "a");
    await writeFile(`${chunkDir}/chunk-002.wav`, "b");
    await writeFile(`${chunkDir}/chunk-003.wav`, "c");

    mockSynthesizeAudio.mockImplementation(async () => {});

    await synthesizeWorker({ bookId, chapterId, resume: true }, { addJob: vi.fn() } as never);

    const remaining = await readdir(chunkDir);
    expect(remaining).toContain("chunk-001.wav");
    expect(remaining).toContain("chunk-002.wav");
    expect(remaining).not.toContain("chunk-003.wav");

    await rm(`/tmp/test-output-${bookId}`, { recursive: true, force: true });
  });

  it("preserves progress when aborted so the paused chapter can show how far it got", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const chapterId = crypto.randomUUID();

    await db.insert(books).values({
      id: bookId,
      title: "Bulgarian Book",
      filename: "book.pdf",
      pdfPath: "/tmp/book.pdf",
      voice: "bg-mlx:narrator",
      speed: 1.0,
    });
    await db.insert(chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Chapter 1",
      rawText: "Сутринта беше тиха и светла.",
      cleanText: "Сутринта беше тиха и светла.",
    });

    mockSynthesizeAudio.mockImplementation(async ({ onProgress }) => {
      await onProgress?.(313, 322);
      throw new TtsAbortedError();
    });

    await synthesizeWorker({ bookId, chapterId }, { addJob: vi.fn() } as never);

    const chapter = row(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(chapter.status).toBe("suspended");
    expect(chapter.progress).toBe("313/322");
  });

  it("suspends the chapter when the generic dispatcher aborts", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const chapterId = crypto.randomUUID();

    await db.insert(books).values({
      id: bookId,
      title: "Bulgarian Book",
      filename: "book.pdf",
      pdfPath: "/tmp/book.pdf",
      voice: "bg-mlx:narrator",
      speed: 1.0,
    });

    await db.insert(chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Chapter 1",
      rawText: "Сутринта беше тиха и светла.",
    });

    mockSynthesizeAudio.mockRejectedValue(new TtsAbortedError());

    await synthesizeWorker({ bookId, chapterId }, { addJob: vi.fn() } as never);

    const chapter = row(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(chapter.status).toBe("suspended");
    expect(chapter.error).toBeNull();
  });

  it("passes the Meta MMS Bulgarian voice through to the dispatcher", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    const chapterId = crypto.randomUUID();

    await db.insert(books).values({
      id: bookId,
      title: "Bulgarian Book",
      filename: "book.pdf",
      pdfPath: "/tmp/book.pdf",
      voice: "bg-mms:bul",
      speed: 1.0,
    });

    await db.insert(chapters).values({
      id: chapterId,
      bookId,
      index: 0,
      title: "Chapter 1",
      rawText: "Добро утро.",
      cleanText: "Добро утро.",
    });

    mockSynthesizeAudio.mockImplementation(async () => {});

    await synthesizeWorker({ bookId, chapterId }, { addJob: vi.fn() } as never);

    expect(mockSynthesizeAudio).toHaveBeenCalledWith(expect.objectContaining({
      voice: "bg-mms:bul",
      speed: 1.0,
      chunkPreviewDir: `/tmp/test-output-${bookId}/chunks/ch000`,
      chunkPreviewUrlBase: `/files/${bookId}/chunks/ch000`,
    }));

    const chapter = row(await db.select().from(chapters).where(eq(chapters.id, chapterId)));
    expect(chapter.synthesizedWith).toEqual({ voice: "bg-mms:bul", speed: null });
  });
});
