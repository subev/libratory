import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, asc } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { getDb, resetDb } from "../../test/setup.ts";
import { books, chapters, documents, DEFAULT_PROFILE_ID } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});
vi.mock("graphile-worker", () => ({ quickAddJob: vi.fn(async () => {}) }));

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "synced-import-"));
vi.mock("./paths.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.ts")>();
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synced-import-paths-"));
  return {
    ...actual,
    outputDir: path.join(root, "output"),
    bookOutputDir: (id: string) => path.join(root, "output", id),
    bookTmpDir: (id: string) => path.join(root, "tmp", id),
  };
});

import { attachSyncedEpubDocument, createSyncedEpubBook, syncedEpubManifest } from "./synced-epub-books.ts";
import { EpubImportError } from "./epub-import.ts";

const AUDIO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]);

// Two narrated chapters whose recordings share a basename in different folders, one of them with
// a pattern character in its name — what a flattening or a globbing reader would mix up
function craftedEpub(): Uint8Array {
  const chapter = (i: number, audio: string) => ({ i, id: `c${i}`, title: `Ch ${i}`, audio, cues: `cues/ch${i}.json`, text: null, durationMs: 1000, pageStart: null, pageEnd: null, mode: "text" });
  const manifest = {
    format: "p2af/1", book: { id: "x", title: "Crafted", author: null, language: "en", medianBodyPt: null, cover: null }, sources: [], pages: [],
    chapters: [chapter(0, "../a/x.m4a"), chapter(1, "../b/x.m4a"), chapter(2, "../audio/odd[1].m4a")],
  };
  const cues = (s: string) => strToU8(JSON.stringify({ format: "p2af/1", totalMs: 1000, granularity: "chunk", cues: [{ t: [0, 1000], s, c: 0 }] }));
  return zipSync({
    "OEBPS/p2af/book.json": strToU8(JSON.stringify(manifest)),
    "OEBPS/p2af/cues/ch0.json": cues("A"), "OEBPS/p2af/cues/ch1.json": cues("B"), "OEBPS/p2af/cues/ch2.json": cues("C"),
    "OEBPS/a/x.m4a": new Uint8Array([1, 1, 1]), "OEBPS/b/x.m4a": new Uint8Array([2, 2, 2]), "OEBPS/audio/odd[1].m4a": new Uint8Array([3, 3, 3]),
  });
}

function readaloudEpub(): Uint8Array {
  const manifest = {
    format: "p2af/1",
    book: { id: "src", title: "Der Prozess", author: "Kafka", language: "de", medianBodyPt: null, cover: null },
    sources: [],
    pages: [],
    chapters: [
      { i: 0, id: "a", title: "Verhaftung", audio: "../audio/ch000.m4a", cues: "cues/ch000.json", text: null, durationMs: 4000, voice: "Thorsten", pageStart: null, pageEnd: null, mode: "text" },
      { i: 1, id: "b", title: "Nachwort", audio: null, cues: null, text: "text/b.json", durationMs: null, pageStart: null, pageEnd: null, mode: "text" },
    ],
  };
  const cues = {
    format: "p2af/1", totalMs: 4000, granularity: "word",
    cues: [{ t: [0, 4000], s: "Jemand musste Josef K. verleumdet haben.", c: 0, w: [[0, 1000, "Jemand"], [1000, 4000, "musste"]] }],
  };
  return zipSync({
    "mimetype": strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>'),
    "OEBPS/package.opf": strToU8("<package/>"),
    "OEBPS/audio/ch000.m4a": AUDIO,
    "OEBPS/p2af/book.json": strToU8(JSON.stringify(manifest)),
    "OEBPS/p2af/cues/ch000.json": strToU8(JSON.stringify(cues)),
    "OEBPS/p2af/text/b.json": strToU8(JSON.stringify({ format: "p2af/1", text: "Ein Nachwort." })),
  });
}

beforeEach(async () => {
  await resetDb(getDb());
});

describe("syncedEpubManifest", () => {
  it("finds the layer in a read-along export and nothing in a plain file", async () => {
    const epub = path.join(tmpRoot, "a.epub");
    await writeFile(epub, readaloudEpub());
    expect((await syncedEpubManifest(epub))?.manifest.book.title).toBe("Der Prozess");
    const plain = path.join(tmpRoot, "plain.epub");
    await writeFile(plain, zipSync({ "mimetype": strToU8("application/epub+zip"), "x.xhtml": strToU8("<p>hi</p>") }));
    expect(await syncedEpubManifest(plain)).toBeNull();
    const notZip = path.join(tmpRoot, "not.epub");
    await writeFile(notZip, "nope");
    expect(await syncedEpubManifest(notZip)).toBeNull();
  });
});

describe("createSyncedEpubBook", () => {
  it("restores chapters with their audio and sync maps, and puts the file on the shelf", async () => {
    const db = getDb();
    const epub = path.join(tmpRoot, "Der_Prozess_readaloud_20261010_091200.epub");
    await writeFile(epub, readaloudEpub());
    const bookId = crypto.randomUUID();
    const book = await createSyncedEpubBook(bookId, { epubPath: epub, filename: "Der_Prozess_readaloud_20261010_091200.epub" }, DEFAULT_PROFILE_ID);
    expect(book).toMatchObject({ kind: "ebook", title: "Der Prozess", author: "Kafka", language: "de", origin: { type: "synced-epub" } });

    const rows = await db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    expect(rows.map((r) => [r.title, r.status, r.durationMs, r.rawText])).toEqual([
      ["Verhaftung", "done", 4000, "Jemand musste Josef K. verleumdet haben."],
      ["Nachwort", "suspended", null, "Ein Nachwort."],
    ]);
    const audioPath = rows[0]?.audioPath ?? "";
    expect(path.basename(audioPath)).toBe("ch000.m4a");
    expect(new Uint8Array(await readFile(audioPath))).toEqual(AUDIO);
    const sync = JSON.parse(await readFile(audioPath.replace(".m4a", ".sync.json"), "utf8"));
    expect(sync.chunks[0].words).toHaveLength(2);

    const [doc] = await db.select().from(documents).where(eq(documents.bookId, bookId));
    expect(doc).toMatchObject({ format: "epub-sync", language: null, chapterCount: 2, narration: { original: { level: "word", durationMs: 4000, voice: "Thorsten" }, translation: null } });
    expect(path.basename(doc?.outputPath ?? "")).toBe("Der_Prozess_readaloud_20261010_091200.epub");
    expect((await stat(doc?.outputPath ?? "")).size).toBeGreaterThan(0);
    await expect(stat(epub)).rejects.toThrow();
    expect(JSON.parse(doc?.chapterIds ?? "[]")).toEqual(rows.map((r) => r.id));
  });

  it("keeps every recording apart whatever the archive names them", async () => {
    const epub = path.join(tmpRoot, "crafted.epub");
    await writeFile(epub, craftedEpub());
    const bookId = crypto.randomUUID();
    await createSyncedEpubBook(bookId, { epubPath: epub, filename: "crafted.epub" }, DEFAULT_PROFILE_ID);
    const rows = await getDb().select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    const bytes = await Promise.all(rows.map(async (r) => [...new Uint8Array(await readFile(r.audioPath ?? ""))]));
    expect(bytes).toEqual([[1, 1, 1], [2, 2, 2], [3, 3, 3]]);
    expect(rows.map((r) => r.rawText)).toEqual(["A", "B", "C"]);
  });

  it("answers a broken cue document as a bad file, not a crash", async () => {
    const epub = path.join(tmpRoot, "broken.epub");
    const good = readaloudEpub();
    // Re-zip with the cue document truncated
    const { unzipSync } = await import("fflate");
    const files = unzipSync(good);
    files["OEBPS/p2af/cues/ch000.json"] = strToU8('{"format":"p2af/1","totalMs":4000,"cues":[{"t":[0');
    await writeFile(epub, zipSync(files));
    await expect(createSyncedEpubBook(crypto.randomUUID(), { epubPath: epub, filename: "broken.epub" }, DEFAULT_PROFILE_ID)).rejects.toThrow(EpubImportError);
    files["OEBPS/p2af/cues/ch000.json"] = strToU8('{"format":"p2af/1","totalMs":4000,"cues":[{"t":"no","s":1,"c":0}]}');
    await writeFile(epub, zipSync(files));
    await expect(createSyncedEpubBook(crypto.randomUUID(), { epubPath: epub, filename: "broken.epub" }, DEFAULT_PROFILE_ID)).rejects.toThrow(/unexpected shape/);
  });

  it("refuses a manifest whose description is not text", async () => {
    const epub = path.join(tmpRoot, "baddesc.epub");
    const { unzipSync } = await import("fflate");
    const files = unzipSync(readaloudEpub());
    const manifest = JSON.parse(new TextDecoder().decode(files["OEBPS/p2af/book.json"]));
    manifest.book.description = { html: "<b>no</b>" };
    files["OEBPS/p2af/book.json"] = strToU8(JSON.stringify(manifest));
    await writeFile(epub, zipSync(files));
    await expect(createSyncedEpubBook(crypto.randomUUID(), { epubPath: epub, filename: "baddesc.epub" }, DEFAULT_PROFILE_ID)).rejects.toThrow(EpubImportError);
  });

  it("refuses an archive that declares far more audio than it holds", async () => {
    const epub = path.join(tmpRoot, "bomb.epub");
    const { unzipSync } = await import("fflate");
    const files = unzipSync(readaloudEpub());
    // A highly compressible recording: the declared size dwarfs the archive
    files["OEBPS/audio/ch000.m4a"] = new Uint8Array(4 * 1024 * 1024);
    await writeFile(epub, zipSync(files, { level: 9 }));
    await expect(createSyncedEpubBook(crypto.randomUUID(), { epubPath: epub, filename: "bomb.epub" }, DEFAULT_PROFILE_ID)).rejects.toThrow(/far more audio/);
  });

  it("attaches a second export to an existing book as another edition, restoring nothing", async () => {
    const db = getDb();
    const first = path.join(tmpRoot, "first.epub");
    await writeFile(first, readaloudEpub());
    const bookId = crypto.randomUUID();
    await createSyncedEpubBook(bookId, { epubPath: first, filename: "first.epub" }, DEFAULT_PROFILE_ID);
    const second = path.join(tmpRoot, "second.epub");
    await writeFile(second, readaloudEpub());
    const { documentId } = await attachSyncedEpubDocument(bookId, { epubPath: second, filename: "second.epub" }, DEFAULT_PROFILE_ID);
    const docs = await db.select().from(documents).where(eq(documents.bookId, bookId));
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.id === documentId)).toMatchObject({ format: "epub-sync", chapterCount: 2, chapterIds: "[]" });
    expect(await db.select().from(chapters).where(eq(chapters.bookId, bookId))).toHaveLength(2);
    await expect(stat(second)).rejects.toThrow();
    // The same export name again lands beside the first, never on it
    const third = path.join(tmpRoot, "second.epub");
    await writeFile(third, readaloudEpub());
    await attachSyncedEpubDocument(bookId, { epubPath: third, filename: "second.epub" }, DEFAULT_PROFILE_ID);
    const paths = (await db.select({ p: documents.outputPath }).from(documents).where(eq(documents.bookId, bookId))).map((d) => path.basename(d.p));
    expect(paths.filter((n) => n.startsWith("second"))).toEqual(["second.epub", "second (2).epub"]);
    expect((await stat(path.join(path.dirname(docs[0]?.outputPath ?? ""), "second (2).epub"))).size).toBeGreaterThan(0);
    // Not for another profile's book
    const other = crypto.randomUUID();
    await writeFile(second, readaloudEpub());
    await expect(attachSyncedEpubDocument(other, { epubPath: second, filename: "second.epub" }, DEFAULT_PROFILE_ID)).rejects.toThrow(EpubImportError);
  });

  it("refuses a plain EPUB", async () => {
    const plain = path.join(tmpRoot, "plain2.epub");
    await writeFile(plain, zipSync({ "x.xhtml": strToU8("<p>hi</p>") }));
    await expect(createSyncedEpubBook(crypto.randomUUID(), { epubPath: plain, filename: "plain2.epub" }, DEFAULT_PROFILE_ID)).rejects.toThrow(EpubImportError);
    expect(await getDb().select().from(books)).toHaveLength(0);
  });
});
