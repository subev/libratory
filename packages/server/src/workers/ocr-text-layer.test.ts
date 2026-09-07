import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

import { getDb, resetDb, row } from "../../test/setup.ts";
import { bookTmpDir } from "../lib/paths.ts";
import { books, bookFiles } from "../schema.ts";

vi.mock("../lib/log.ts", () => ({
  appendLog: vi.fn(async () => {}),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { ocrTextLayer } from "./ocr-text-layer.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/scanned-page.pdf");

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const exists = (p: string) => stat(p).then(() => true, () => false);

async function scannedBook(engineSet = true) {
  const db = getDb();
  const dir = await mkdtemp(path.join(tmpdir(), "ocr-worker-"));
  dirs.push(dir);
  const pdfPath = path.join(dir, "00_scan.pdf");
  await copyFile(FIXTURE, pdfPath);

  const bookId = crypto.randomUUID();
  await db.insert(books).values({
    id: bookId,
    title: "Scanned Book",
    filename: "scan.pdf",
    pdfPath,
    language: "en",
    ...(engineSet ? { ocrEngine: "tesseract" as const } : {}),
  });
  await db.insert(bookFiles).values({ bookId, index: 0, filename: "scan.pdf", pdfPath, status: "raw" });
  dirs.push(bookTmpDir(bookId));
  return { bookId, pdfPath };
}

describe("ocrTextLayer worker", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("writes a searchable copy beside the original and records what it read", async () => {
    const db = getDb();
    const { bookId, pdfPath } = await scannedBook();
    const addJob = vi.fn();

    await ocrTextLayer({ bookId }, { addJob } as any);

    const file = row(await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)));
    expect(file.searchablePdfPath).toBe(path.join(path.dirname(pdfPath), "00_scan.ocr.pdf"));
    expect(await exists(file.searchablePdfPath ?? "")).toBe(true);
    expect(await exists(pdfPath)).toBe(true);
    expect(file.ocrEngine).toBe("tesseract");
    expect(file.rawWords).toBeGreaterThan(0);
    expect(file.rawText).toContain("Voyage");
    expect(file.ocrConfidence).toBeGreaterThan(0.5);
    expect(file.ocrLowConfidenceFraction).toBeLessThan(0.5);

    const book = row(await db.select().from(books).where(eq(books.id, bookId)));
    expect(book.status).toBe("pending");
    expect(addJob).toHaveBeenCalledWith("indexBook", { bookId }, expect.objectContaining({ jobKey: `index:${bookId}` }));
  }, 60_000);

  it("does nothing on a second run, and reads the pages again only when forced", async () => {
    const db = getDb();
    const { bookId } = await scannedBook();
    await ocrTextLayer({ bookId }, { addJob: vi.fn() } as any);

    await db.update(bookFiles).set({ ocrConfidence: 0.1 }).where(eq(bookFiles.bookId, bookId));
    const addJob = vi.fn();
    await ocrTextLayer({ bookId }, { addJob } as any);
    expect(row(await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId))).ocrConfidence).toBeCloseTo(0.1);
    expect(addJob).not.toHaveBeenCalled();

    await ocrTextLayer({ bookId, force: true }, { addJob: vi.fn() } as any);
    expect(row(await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId))).ocrConfidence).toBeGreaterThan(0.5);
  }, 120_000);

  it("says why and stops when the book has no OCR engine set", async () => {
    const db = getDb();
    const { bookId } = await scannedBook(false);

    await ocrTextLayer({ bookId }, { addJob: vi.fn() } as any);

    expect(row(await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId))).searchablePdfPath).toBeNull();
    expect(row(await db.select().from(books).where(eq(books.id, bookId))).status).toBe("pending");
  });
});
