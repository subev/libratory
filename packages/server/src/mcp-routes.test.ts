import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb, resetDb, row } from "../test/setup.ts";
import { books, bookFiles, chapters } from "./schema.ts";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { uploadsDir } from "./lib/paths.ts";
import type { AddressInfo } from "node:net";
import http from "node:http";

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
  return { ...actual, uploadsDir: path.join(os.tmpdir(), "libratory-test-mcp-uploads") };
});

vi.mock("./lib/model-bundles.ts", () => ({
  listModelBundles: async () => [{ id: "extraction", label: "Marker/Surya", unlocks: "full extraction", approxMb: 5100, appleSiliconOnly: false, installed: true, downloading: false, progress: null, error: null }],
  bundleInstalled: async () => true,
  readCapabilities: async () => ({ mlx: true, cuda: false }),
  startBundleDownload: () => ({ started: true }),
}));

vi.mock("./lib/cartesia.ts", () => ({ listCartesiaVoices: async () => [{ id: "abc123", name: "Sofia", language: "bg", gender: "feminine", tagline: "warm" }] }));
vi.mock("./lib/elevenlabs.ts", () => ({ listElevenLabsVoices: async () => [] }));
vi.mock("./lib/say-voices.ts", () => ({ listSayVoices: async () => [{ slug: "daria", name: "Daria", locale: "bg_BG", sample: "" }] }));

import { registerMcpRoutes } from "./mcp-routes.ts";

const apps: Array<ReturnType<typeof Fastify>> = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  mockQuickAddJob.mockClear();
});

async function listen(trustedHosts = new Set<string>()) {
  const app = Fastify();
  apps.push(app);
  registerMcpRoutes(app, trustedHosts);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

async function connect(url: string, headers?: Record<string, string>) {
  const client = new Client({ name: "test", version: "0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

function parse<T = any>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(first!.text);
}

async function samplePdf() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "libratory-mcp-"));
  const file = path.join(dir, "My_Book.pdf");
  await writeFile(file, "%PDF-1.4\n%%EOF\n");
  return file;
}

describe("/mcp", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("refuses a Host that is neither loopback, a literal nor trusted", async () => {
    const url = await listen();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "attacker.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    });
    expect(status).toBe(403);
  });

  it("lists the curated tools", async () => {
    const client = await connect(await listen());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "assemble_book",
      "cancel_book",
      "cleanup_chapters",
      "export_book",
      "extract_book",
      "get_book",
      "get_book_logs",
      "get_book_text",
      "get_capabilities",
      "get_chapter",
      "inspect_pdf",
      "list_books",
      "list_voices",
      "redetect_chapters",
      "search_library",
      "set_book_settings",
      "start_download",
      "synthesize_book",
      "update_chapter",
      "upload_book",
      "wait_for_book",
    ]);
  });

  it("creates a book from a local PDF path and queues the full pipeline", async () => {
    const client = await connect(await listen());
    const file = await samplePdf();

    const uploaded = parse(await client.callTool({ name: "upload_book", arguments: { paths: [file], language: "en" } }));
    expect(uploaded.title).toBe("My Book");
    expect(uploaded.status).toBe("pending");
    expect(uploaded.files).toEqual([expect.objectContaining({ index: 0, filename: "My_Book.pdf", status: "pending" })]);

    const book = row(await getDb().select().from(books).where(eq(books.id, uploaded.id)));
    expect(book.language).toBe("en");
    const stored = row(await getDb().select().from(bookFiles).where(eq(bookFiles.bookId, uploaded.id)));
    expect(path.dirname(stored.pdfPath)).toBe(path.join(uploadsDir, uploaded.id));
    expect(await readdir(path.join(uploadsDir, uploaded.id))).toHaveLength(1);

    const tasks = mockQuickAddJob.mock.calls.map((call: unknown[]) => call[1]);
    expect(tasks).toEqual(["rawExtract", "extract"]);

    const listed = parse(await client.callTool({ name: "list_books", arguments: {} }));
    expect(listed.map((b: { id: string }) => b.id)).toContain(uploaded.id);

    const fetched = parse(await client.callTool({ name: "get_book", arguments: { id: uploaded.id } }));
    expect(fetched.id).toBe(uploaded.id);
    expect(fetched.chapters).toEqual([]);
  });

  it("scopes books to the profile header", async () => {
    const url = await listen();
    const file = await samplePdf();
    const other = "11111111-1111-4111-8111-111111111111";
    await getDb().execute(`insert into profiles (id, name) values ('${other}', 'Other')`);

    const scoped = await connect(url, { "x-profile-id": other });
    const uploaded = parse(await scoped.callTool({ name: "upload_book", arguments: { paths: [file] } }));

    const mine = parse(await scoped.callTool({ name: "list_books", arguments: {} }));
    expect(mine.map((b: { id: string }) => b.id)).toEqual([uploaded.id]);
    const theirs = parse(await (await connect(url)).callTool({ name: "list_books", arguments: {} }));
    expect(theirs).toEqual([]);
  });

  it("reports bad paths as tool errors and leaves nothing behind", async () => {
    const client = await connect(await listen());
    const before = (await getDb().select().from(books)).length;

    const relative = await client.callTool({ name: "upload_book", arguments: { paths: ["book.pdf"] } });
    expect(relative.isError).toBe(true);
    expect((relative.content as Array<{ text: string }>)[0]?.text).toMatch(/absolute path/);

    const missing = await client.callTool({ name: "upload_book", arguments: { paths: ["/nowhere/book.pdf"] } });
    expect(missing.isError).toBe(true);

    expect((await getDb().select().from(books)).length).toBe(before);
    expect(mockQuickAddJob).not.toHaveBeenCalled();
  });

  it("inspects a PDF before upload", async () => {
    const client = await connect(await listen());
    const fixture = path.resolve("../../e2e/fixtures/tiny-book.pdf");
    const info = parse(await client.callTool({ name: "inspect_pdf", arguments: { path: fixture } }));
    expect(info).toMatchObject({ pages: 3, hasTextLayer: true, scanned: false, language: "en" });
    expect(info.words).toBeGreaterThan(50);
    expect(info.sample).toMatch(/Chapter 1/);
  });

  it("lists voices across static and live engines and filters by language", async () => {
    const client = await connect(await listen());
    const all = parse(await client.callTool({ name: "list_voices", arguments: {} }));
    const ids = all.map((v: { id: string }) => v.id);
    expect(ids).toContain("kokoro:af_heart");
    expect(ids).toContain("bg-mlx:narrator");
    expect(ids).toContain("say:daria");
    expect(ids).toContain("cartesia:abc123");

    const bulgarian = parse(await client.callTool({ name: "list_voices", arguments: { language: "bg" } }));
    const bgIds = bulgarian.map((v: { id: string }) => v.id);
    expect(bgIds).toEqual(expect.arrayContaining(["bg-mlx:narrator", "bg-mms:bul", "kugel:default", "say:daria", "cartesia:abc123"]));
    expect(bgIds).not.toContain("kokoro:af_heart");
    expect(bulgarian.find((v: { id: string }) => v.id === "cartesia:abc123")).toMatchObject({ cloud: true, gender: "F", engine: "cartesia" });
  });

  it("reports capabilities an agent can act on", async () => {
    const client = await connect(await listen());
    const caps = parse(await client.callTool({ name: "get_capabilities", arguments: {} }));
    expect(caps.hardware).toEqual({ mlx: true, cuda: false });
    expect(caps.bundles[0]).toMatchObject({ id: "extraction", installed: true });
    expect(caps.ocrEngines).toEqual([{ id: "tesseract", default: true, needsBundle: null }, { id: "surya", default: false, needsBundle: "extraction" }]);
    expect(caps.ocrLanguages.find((l: { code: string }) => l.code === "eng")).toMatchObject({ name: "English", iso: "en", installed: true });
    expect(caps.ocrLanguages.length).toBeLessThan(caps.ocrLanguagesAvailable);
    expect(caps.cloudKeys.map((k: { envVar: string }) => k.envVar)).toContain("CARTESIA_API_KEY");
    expect(JSON.stringify(caps)).not.toMatch(/keyHint|sk-/);
  });

  it("updates title, text and selection of a chapter in one call", async () => {
    const client = await connect(await listen());
    const uploaded = parse(await client.callTool({ name: "upload_book", arguments: { paths: [await samplePdf()] } }));
    const [chapter] = await getDb().insert(chapters).values({ bookId: uploaded.id, index: 0, title: "Part 1", rawText: "Original", status: "suspended" }).returning();
    await client.callTool({ name: "update_chapter", arguments: { id: chapter!.id, title: "ПРЕДГОВОР", text: "Edited", selected: false } });
    const fetched = parse(await client.callTool({ name: "get_chapter", arguments: { id: chapter!.id } }));
    expect(fetched).toMatchObject({ title: "ПРЕДГОВОР", text: "Edited", textSource: "custom", selected: false });
    const nothing = await client.callTool({ name: "update_chapter", arguments: { id: chapter!.id } });
    expect(nothing.isError).toBe(true);
  });

  it("wait_for_book returns at the timeout with the current state", async () => {
    const client = await connect(await listen());
    const uploaded = parse(await client.callTool({ name: "upload_book", arguments: { paths: [await samplePdf()] } }));

    const waited = parse(await client.callTool({ name: "wait_for_book", arguments: { id: uploaded.id, until: "text", timeoutSeconds: 1 } }));
    expect(waited).toMatchObject({ satisfied: false, reason: "timeout" });
    expect(waited.book.id).toBe(uploaded.id);
  });
});
