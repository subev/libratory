import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../test/setup.ts";
import { books, bookFiles, chapters, folders } from "./schema.ts";
import { eq, asc } from "drizzle-orm";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import { uploadsDir } from "./lib/paths.ts";

const { mockQuickAddJob } = vi.hoisted(() => ({
  mockQuickAddJob: vi.fn(async () => {}),
}));

vi.mock("graphile-worker", () => ({
  quickAddJob: mockQuickAddJob,
}));

vi.mock("./db.ts", async () => {
  const { getDb } = await import("../test/setup.ts");
  return { get db() { return getDb(); } };
});

vi.mock("./lib/paths.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/paths.ts")>();
  const os = await import("node:os");
  const path = await import("node:path");
  return { ...actual, uploadsDir: path.join(os.tmpdir(), "libratory-test-uploads") };
});

import { registerUploadRoutes } from "./upload-routes.ts";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(preservePath = false) {
  const app = Fastify();
  apps.push(app);
  await app.register(multipart, { preservePath, limits: { fileSize: 500 * 1024 * 1024 } });
  registerUploadRoutes(app);
  await app.ready();
  return app;
}

const BOUNDARY = "----vitestboundary";

function multipartBody(parts: Array<{ name: string; value: string; filename?: string }>) {
  const chunks = parts.map((p) => {
    const disposition = p.filename
      ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/pdf`
      : `Content-Disposition: form-data; name="${p.name}"`;
    return `--${BOUNDARY}\r\n${disposition}\r\n\r\n${p.value}\r\n`;
  });
  return {
    payload: chunks.join("") + `--${BOUNDARY}--\r\n`,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

describe("POST /upload", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockReset();
  });

  it("keeps untrusted filenames as metadata and generates the storage path", async () => {
    const app = await createApp(true);
    const filename = "nested/../../outside.pdf";
    const { payload, headers } = multipartBody([{ name: "file", filename, value: "%PDF-test" }]);
    const res = await app.inject({ method: "POST", url: "/upload", payload, headers });
    expect(res.statusCode).toBe(200);
    const [file] = await getDb().select().from(bookFiles);
    expect(file?.filename).toBe(filename);
    if (!file) throw new Error("Uploaded file missing");
    expect(path.dirname(file.pdfPath)).toBe(path.join(uploadsDir, file.bookId));
    expect(path.basename(file.pdfPath)).toMatch(/^00_[a-f0-9-]{36}\.pdf$/);
    expect(await readFile(file.pdfPath, "utf8")).toBe("%PDF-test");
  });

  it("creates a raw-only book by default and queues raw text plus the OCR step, never extract", async () => {
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "file", value: "%PDF-fake", filename: "my_book.pdf" },
    ]);

    const res = await app.inject({ method: "POST", url: "/upload", payload, headers });

    expect(res.statusCode).toBe(200);
    const book = res.json();
    expect(book.title).toBe("my book");

    const db = getDb();
    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, book.id));
    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe("raw");

    expect(mockQuickAddJob).toHaveBeenCalledTimes(2);
    expect((mockQuickAddJob.mock.calls as unknown[][]).map((c) => c[1])).toEqual(["rawExtract", "ocrTextLayer"]);
    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.any(Object),
      "rawExtract",
      { bookId: book.id },
      { maxAttempts: 1 },
    );
  });

  it("assigns the book to the given folder", async () => {
    const db = getDb();
    const folder = row(await db.insert(folders).values({ name: "History" }).returning());
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "file", value: "%PDF-fake", filename: "my_book.pdf" },
      { name: "folderId", value: folder.id },
    ]);

    const res = await app.inject({ method: "POST", url: "/upload", payload, headers });

    expect(res.statusCode).toBe(200);
    const book = row(await db.select().from(books));
    expect(book.folderId).toBe(folder.id);
  });

  it("saves the language chosen at upload, so the voice picker starts in the right place", async () => {
    const db = getDb();
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "file", value: "%PDF-fake", filename: "my_book.pdf" },
      { name: "language", value: "bg" },
    ]);

    const res = await app.inject({ method: "POST", url: "/upload", payload, headers });

    expect(res.statusCode).toBe(200);
    expect(row(await db.select().from(books)).language).toBe("bg");
  });

  it("leaves the language unset when the upload does not carry one", async () => {
    const db = getDb();
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "file", value: "%PDF-fake", filename: "my_book.pdf" },
    ]);

    const res = await app.inject({ method: "POST", url: "/upload", payload, headers });

    expect(res.statusCode).toBe(200);
    expect(row(await db.select().from(books)).language).toBeNull();
  });

  it("rejects an unknown folderId", async () => {
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "file", value: "%PDF-fake", filename: "my_book.pdf" },
      { name: "folderId", value: crypto.randomUUID() },
    ]);

    const res = await app.inject({ method: "POST", url: "/upload", payload, headers });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Folder not found");
    const db = getDb();
    expect(await db.select().from(books)).toHaveLength(0);
  });

  it("queues extract as well when fullExtract is set", async () => {
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "fullExtract", value: "true" },
      { name: "file", value: "%PDF-fake", filename: "book.pdf" },
    ]);

    const res = await app.inject({ method: "POST", url: "/upload", payload, headers });

    expect(res.statusCode).toBe(200);
    const book = res.json();

    const db = getDb();
    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, book.id));
    expect(files[0]?.status).toBe("pending");

    const jobNames = mockQuickAddJob.mock.calls.map((c: any[]) => c[1]);
    expect(jobNames).toEqual(["rawExtract", "extract"]);
  });

  it("stores a queued noteJob and passes the note to rawExtract", async () => {
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "notePrompt", value: "Give me the key arguments" },
      { name: "noteModel", value: "pro" },
      { name: "file", value: "%PDF-fake", filename: "book.pdf" },
    ]);

    const res = await app.inject({ method: "POST", url: "/upload", payload, headers });

    expect(res.statusCode).toBe(200);
    const book = res.json();
    expect(book.noteJob).toMatchObject({ status: "queued", prompt: "Give me the key arguments", model: "pro" });

    expect(mockQuickAddJob).toHaveBeenCalledWith(
      expect.any(Object),
      "rawExtract",
      { bookId: book.id, note: { prompt: "Give me the key arguments", model: "pro" } },
      { maxAttempts: 1 },
    );
  });

  it("rejects an oversized note prompt", async () => {
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "notePrompt", value: "x".repeat(4001) },
      { name: "file", value: "%PDF-fake", filename: "book.pdf" },
    ]);

    const res = await app.inject({ method: "POST", url: "/upload", payload, headers });

    expect(res.statusCode).toBe(400);
    const db = getDb();
    expect(await db.select().from(books)).toHaveLength(0);
  });
});

describe("POST /upload/:bookId (append)", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockReset();
  });

  async function insertBookWithFile(status: "raw" | "done") {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({
      id: bookId,
      title: "Existing",
      filename: "vol1.pdf",
      pdfPath: "/tmp/vol1.pdf",
    });
    await db.insert(bookFiles).values({
      bookId,
      index: 0,
      filename: "vol1.pdf",
      pdfPath: "/tmp/vol1.pdf",
      status,
    });
    return bookId;
  }

  it("appends raw files to a raw-only book and queues the OCR step, not extract", async () => {
    const bookId = await insertBookWithFile("raw");
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "file", value: "%PDF-fake", filename: "vol2.pdf" },
    ]);

    const res = await app.inject({ method: "POST", url: `/upload/${bookId}`, payload, headers });

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)).orderBy(asc(bookFiles.index));
    expect(files.map((f) => f.status)).toEqual(["raw", "raw"]);

    const jobNames = mockQuickAddJob.mock.calls.map((c: any[]) => c[1]);
    expect(jobNames).toEqual(["rawExtract", "ocrTextLayer"]);
  });

  it("appends pending files and queues extract for a fully-extracted book", async () => {
    const bookId = await insertBookWithFile("done");
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "file", value: "%PDF-fake", filename: "vol2.pdf" },
    ]);

    const res = await app.inject({ method: "POST", url: `/upload/${bookId}`, payload, headers });

    expect(res.statusCode).toBe(200);
    const db = getDb();
    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)).orderBy(asc(bookFiles.index));
    expect(files.map((f) => f.status)).toEqual(["done", "pending"]);

    const jobNames = mockQuickAddJob.mock.calls.map((c: any[]) => c[1]);
    expect(jobNames).toEqual(["rawExtract", "extract"]);
  });

  it("appends after a custom source position even when deleted files left a large gap", async () => {
    const bookId = await insertBookWithFile("raw");
    const db = getDb();
    await db.update(bookFiles).set({ position: 20 }).where(eq(bookFiles.bookId, bookId));
    const app = await createApp();
    const { payload, headers } = multipartBody([{ name: "file", value: "%PDF-fake", filename: "next.pdf" }]);
    const res = await app.inject({ method: "POST", url: `/upload/${bookId}`, payload, headers });
    expect(res.statusCode).toBe(200);
    const files = await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)).orderBy(asc(bookFiles.index));
    expect(files.map((file) => [file.index, file.position])).toEqual([[0, 20], [1, 21]]);
  });
});

describe("POST /upload/:bookId on synthetic books", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockReset();
  });

  it("rejects with 400 and creates no phantom file rows", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Digest", kind: "digest" });

    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "file", value: "%PDF-fake", filename: "extra.pdf" },
    ]);

    const res = await app.inject({ method: "POST", url: `/upload/${bookId}`, payload, headers });

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId))).toHaveLength(0);
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });
});

function fileUpload(filename: string, bytes: Uint8Array, fields: Record<string, string> = {}) {
  const head = Object.entries(fields)
    .map(([name, value]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join("");
  return {
    payload: Buffer.concat([
      Buffer.from(`${head}--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/epub+zip\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

function tinyEpub(): Uint8Array {
  const page = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${body}</body></html>`;
  const prose = "The tide came in slowly over the flat grey sand, and nobody on the shore said a word about it. ".repeat(6);
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>`),
    "OPS/package.opf": strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Tide</dc:title><dc:creator>Mara Quill</dc:creator><dc:language>fr</dc:language></metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    "OPS/nav.xhtml": strToU8(page(`<nav epub:type="toc"><ol><li><a href="c1.xhtml">Low Water</a></li><li><a href="c2.xhtml">High Water</a></li></ol></nav>`)),
    "OPS/c1.xhtml": strToU8(page(`<h1>Low Water</h1><p>${prose}<span epub:type="pagebreak" title="7">7</span></p>`)),
    "OPS/c2.xhtml": strToU8(page(`<h1>High Water</h1><p>${prose}</p><p>8</p>`)),
  });
}

describe("POST /upload/ebook with a bookId", () => {
  it("refuses a bad id and leaves no upload directory behind", async () => {
    await resetDb(getDb());
    const app = await createApp();
    const { payload, headers } = multipartBody([
      { name: "bookId", value: "not-a-uuid" },
      { name: "file", value: "PK\u0003\u0004", filename: "x.epub" },
    ]);
    const before = (await readdir(uploadsDir).catch(() => [])).length;
    const res = await app.inject({ method: "POST", url: "/upload/ebook", payload, headers });
    expect(res.statusCode).toBe(400);
    expect((await readdir(uploadsDir).catch(() => [])).length).toBe(before);
  });
});

describe("POST /upload/ebook", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    mockQuickAddJob.mockReset();
  });

  it("creates a book with no PDF whose chapters come from the table of contents", async () => {
    const app = await createApp();
    const { payload, headers } = fileUpload("the-tide.epub", tinyEpub());
    const res = await app.inject({ method: "POST", url: "/upload/ebook", payload, headers });
    expect(res.statusCode).toBe(200);
    const bookId = res.json<{ id: string }>().id;

    const book = row(await getDb().select().from(books).where(eq(books.id, bookId)));
    expect(book).toMatchObject({
      kind: "ebook",
      title: "The Tide",
      author: "Mara Quill",
      language: "en",
      pdfPath: null,
      origin: { type: "ebook", filename: "the-tide.epub" },
    });
    expect(await getDb().select().from(bookFiles).where(eq(bookFiles.bookId, bookId))).toHaveLength(0);

    const rows = await getDb().select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.index));
    expect(rows.map((ch) => [ch.title, ch.status])).toEqual([["Low Water", "suspended"], ["High Water", "suspended"]]);
    for (const ch of rows) {
      expect(ch.cleanText).toBeTruthy();
      expect(ch.rawText).not.toMatch(/\b[78]\b/);
    }

    // Kept for a later re-import; no extraction or synthesis queued, only search indexing
    expect((await stat(path.join(uploadsDir, bookId, "source.epub"))).isFile()).toBe(true);
    expect(mockQuickAddJob.mock.calls.map((call) => (call as unknown[])[1])).toEqual(["indexBook"]);
  });

  it("files the book into the folder and under the title it was given", async () => {
    const db = getDb();
    const [folder] = await db.insert(folders).values({ name: "Imports" }).returning();
    if (!folder) throw new Error("Folder insert failed");
    const app = await createApp();
    const { payload, headers } = fileUpload("x.epub", tinyEpub(), { folderId: folder.id, title: "My Title" });
    const res = await app.inject({ method: "POST", url: "/upload/ebook", payload, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "My Title", folderId: folder.id });
  });

  it("refuses a file it cannot read and leaves nothing behind", async () => {
    const before = await readdir(uploadsDir).catch(() => []);
    const app = await createApp();
    const { payload, headers } = fileUpload("broken.epub", strToU8("not a zip at all"));
    const res = await app.inject({ method: "POST", url: "/upload/ebook", payload, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Not an EPUB/);
    expect(await getDb().select().from(books)).toHaveLength(0);
    expect(await readdir(uploadsDir).catch(() => [])).toEqual(before);
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("refuses a folder from another profile and leaves nothing behind", async () => {
    const before = await readdir(uploadsDir).catch(() => []);
    const app = await createApp();
    const { payload, headers } = fileUpload("x.epub", tinyEpub(), { folderId: "00000000-0000-4000-8000-000000000000" });
    const res = await app.inject({ method: "POST", url: "/upload/ebook", payload, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Folder not found");
    expect(await getDb().select().from(books)).toHaveLength(0);
    expect(await readdir(uploadsDir).catch(() => [])).toEqual(before);
  });

  it("refuses an upload with no EPUB in it", async () => {
    const app = await createApp();
    const { payload, headers } = multipartBody([{ name: "file", filename: "book.pdf", value: "%PDF-test" }]);
    const res = await app.inject({ method: "POST", url: "/upload/ebook", payload, headers });
    expect(res.statusCode).toBe(400);
    expect(await getDb().select().from(books)).toHaveLength(0);
  });
});
