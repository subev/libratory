import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, row } from "../test/setup.ts";
import { books, bookFiles, folders } from "./schema.ts";
import { eq, asc } from "drizzle-orm";

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

async function createApp() {
  const app = Fastify();
  apps.push(app);
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });
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

  it("creates a raw-only book by default and queues only rawExtract", async () => {
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

    expect(mockQuickAddJob).toHaveBeenCalledTimes(1);
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

  it("appends raw files to a raw-only book without queuing extract", async () => {
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
    expect(jobNames).toEqual(["rawExtract"]);
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
