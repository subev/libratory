import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, resetDb, row } from "../test/setup.ts";
import { books, devices, documents, profiles, shelfDownloads, shelfFetches, DEFAULT_PROFILE_ID } from "./schema.ts";

vi.mock("./db.ts", async () => {
  const { getDb } = await import("../test/setup.ts");
  return { get db() { return getDb(); } };
});

const testOutputDir = path.join(os.tmpdir(), "libratory-test-shelf-output");
vi.mock("./lib/paths.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/paths.ts")>();
  const os = await import("node:os");
  const path = await import("node:path");
  return { ...actual, outputDir: path.join(os.tmpdir(), "libratory-test-shelf-output") };
});

// The Tailscale probe shells out; the route only needs an answer
vi.mock("./lib/reachable-address.ts", () => ({
  reachableAddress: vi.fn(async () => ({ host: "mini.tail4a2f.ts.net", origin: "http://mini.tail4a2f.ts.net:3034", via: "tailscale" })),
}));

import { registerShelfRoutes } from "./shelf-routes.ts";
import { env } from "./env.ts";
import { pairingTokens } from "./lib/pairing.ts";

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp() {
  const app = Fastify();
  apps.push(app);
  // sendFile comes from the static plugin main.ts mounts on the output dir
  await app.register(fastifyStatic, { root: testOutputDir, serve: false });
  registerShelfRoutes(app);
  await app.ready();
  return app;
}

async function makeProfile(name: string) {
  return row(await getDb().insert(profiles).values({ name }).returning());
}

async function makeDocument(profileId: string, over: Partial<typeof documents.$inferInsert> = {}) {
  const db = getDb();
  const book = row(await db.insert(books).values({ title: "Der Prozess", author: "Kafka", language: "de", textSource: "Project Gutenberg", rights: "Public domain", profileId }).returning());
  const outputPath = path.join(testOutputDir, book.id, `${over.format ?? "epub-sync"}-${Math.random().toString(36).slice(2)}.epub`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "PK\u0003\u0004 not really an epub");
  const doc = row(
    await db
      .insert(documents)
      .values({ bookId: book.id, format: "epub-sync", outputPath, chapterCount: 10, chapterSummary: "1-10", chapterIds: "[]", ...over })
      .returning(),
  );
  return { book, doc };
}

async function pair(app: Awaited<ReturnType<typeof createApp>>, profileId: string, name = "Petur's iPhone") {
  const { token } = pairingTokens.mint(profileId);
  const res = await app.inject({ method: "POST", url: "/shelf/pair", payload: { token, name } });
  expect(res.statusCode).toBe(200);
  return res.json() as { deviceId: string; deviceKey: string; profile: { id: string; name: string }; bookCount: number };
}

beforeEach(async () => {
  await resetDb(getDb());
});

describe("pairing", () => {
  it("lets the phone look before it adds, then spends the code on the second call", async () => {
    const app = await createApp();
    const profile = await makeProfile("Petur");
    await makeDocument(profile.id);
    const { token } = pairingTokens.mint(profile.id);

    const peek = await app.inject({ method: "GET", url: `/shelf/pair/${token}` });
    expect(peek.statusCode).toBe(200);
    expect(peek.json()).toMatchObject({ profile: { id: profile.id, name: "Petur" }, bookCount: 1, via: "tailscale" });
    expect(typeof peek.json().machine).toBe("string");

    const paired = await app.inject({ method: "POST", url: "/shelf/pair", payload: { token, name: "Petur's iPhone" } });
    expect(paired.statusCode).toBe(200);
    expect(paired.json()).toMatchObject({ profile: { id: profile.id }, bookCount: 1 });
    expect(paired.json().deviceKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const again = await app.inject({ method: "POST", url: "/shelf/pair", payload: { token, name: "Someone else" } });
    expect(again.statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: `/shelf/pair/${token}` })).statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: "/shelf/pair/never-minted" })).statusCode).toBe(404);

    const [device] = await getDb().select().from(devices).where(eq(devices.profileId, profile.id));
    expect(device?.name).toBe("Petur's iPhone");
    expect(device?.keyHash).not.toContain(paired.json().deviceKey);
  });

  it("names the public host as the machine and says internet behind a proxy", async () => {
    const app = await createApp();
    env.PUBLIC_ORIGIN = "https://shelf.example.org";
    try {
      const { token } = pairingTokens.mint(DEFAULT_PROFILE_ID);
      const peek = await app.inject({ method: "GET", url: `/shelf/pair/${token}` });
      expect(peek.json()).toMatchObject({ machine: "shelf.example.org", via: "internet" });
    } finally {
      env.PUBLIC_ORIGIN = undefined;
    }
  });

  it("refuses a body without a name", async () => {
    const app = await createApp();
    const { token } = pairingTokens.mint(DEFAULT_PROFILE_ID);
    expect((await app.inject({ method: "POST", url: "/shelf/pair", payload: { token } })).statusCode).toBe(400);
  });
});

describe("the public shelf", () => {
  it("answers anyone for the public profile, counts the download anonymously, and still knows a paired device", async () => {
    const app = await createApp();
    const mine = await makeProfile("Commons");
    const theirs = await makeProfile("Petur");
    const { book, doc } = await makeDocument(mine.id);
    await makeDocument(theirs.id);
    env.PUBLIC_SHELF_PROFILE = mine.id;
    try {
      const res = await app.inject({ method: "GET", url: "/shelf" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ public: true, device: null, profile: { id: mine.id, name: "Commons" } });
      expect(res.json().books.map((b: { id: string }) => b.id)).toEqual([book.id]);
      expect(res.json().books[0].editions[0].downloaded).toBe(false);

      const dl = await app.inject({ method: "GET", url: `/shelf/documents/${doc.id}`, headers: { "user-agent": "Libratory-Reader/1.2 (iOS 18.1; iPhone16,2)", "cf-ipcountry": "BG" } });
      expect(dl.statusCode).toBe(200);
      const fetches = await getDb().select().from(shelfFetches);
      expect(fetches.map((f) => [f.documentId, f.userAgent, f.country])).toEqual([[doc.id, "Libratory-Reader/1.2 (iOS 18.1; iPhone16,2)", "BG"]]);
      expect(await getDb().select().from(shelfDownloads)).toEqual([]);

      // A paired device on another profile still sees its own shelf, not the public one
      const { deviceKey } = await pair(app, theirs.id);
      const own = await app.inject({ method: "GET", url: "/shelf", headers: { authorization: `Bearer ${deviceKey}` } });
      expect(own.json()).toMatchObject({ public: false, profile: { id: theirs.id } });
      // A wrong key is still refused, public shelf or not
      expect((await app.inject({ method: "GET", url: "/shelf", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
      // The other profile's files are not on the public shelf
      const foreign = await makeDocument(theirs.id);
      expect((await app.inject({ method: "GET", url: `/shelf/documents/${foreign.doc.id}` })).statusCode).toBe(404);
    } finally {
      env.PUBLIC_SHELF_PROFILE = undefined;
    }
  });

  it("counts a public download once, never for a probe, and never for a hidden or sized request", async () => {
    const app = await createApp();
    const { doc } = await makeDocument(DEFAULT_PROFILE_ID);
    const hidden = await makeDocument(DEFAULT_PROFILE_ID, { shelfHidden: true });
    env.PUBLIC_SHELF_PROFILE = "default";
    try {
      expect((await app.inject({ method: "HEAD", url: `/shelf/documents/${doc.id}` })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/shelf/documents/${doc.id}`, headers: { range: "bytes=0-0" } })).statusCode).toBe(206);
      expect((await app.inject({ method: "GET", url: `/shelf/documents/${doc.id}`, headers: { range: "bytes=5-" } })).statusCode).toBe(206);
      expect((await app.inject({ method: "GET", url: `/shelf/documents/${hidden.doc.id}` })).statusCode).toBe(404);
      expect((await getDb().select().from(shelfFetches)).map((f) => f.documentId)).toEqual([doc.id]);
      // An offered credential that is not a device key is refused, public shelf or not
      expect((await app.inject({ method: "GET", url: "/shelf", headers: { authorization: "Basic abc" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/shelf", headers: { authorization: "Bearer " } })).statusCode).toBe(401);
      // The public listing names no device and no count
      const listing = await app.inject({ method: "GET", url: "/shelf" });
      expect(JSON.stringify(listing.json())).not.toMatch(/downloadedBy|fetches|deviceId/);
    } finally {
      env.PUBLIC_SHELF_PROFILE = undefined;
    }
  });

  it("resolves `default` to the default profile", async () => {
    const app = await createApp();
    await makeDocument(DEFAULT_PROFILE_ID);
    env.PUBLIC_SHELF_PROFILE = "default";
    try {
      const res = await app.inject({ method: "GET", url: "/shelf" });
      expect(res.statusCode).toBe(200);
      expect(res.json().books).toHaveLength(1);
    } finally {
      env.PUBLIC_SHELF_PROFILE = undefined;
    }
  });
});

describe("the shelf", () => {
  it("answers 401 to no key, a wrong key, and a forgotten phone", async () => {
    const app = await createApp();
    expect((await app.inject({ method: "GET", url: "/shelf" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/shelf", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    const { deviceId, deviceKey } = await pair(app, DEFAULT_PROFILE_ID);
    const auth = { authorization: `Bearer ${deviceKey}` };
    expect((await app.inject({ method: "GET", url: "/shelf", headers: auth })).statusCode).toBe(200);
    await getDb().delete(devices).where(eq(devices.id, deviceId));
    expect((await app.inject({ method: "GET", url: "/shelf", headers: auth })).statusCode).toBe(401);
  });

  it("lists only this profile's visible read-along and bilingual files, grouped by book", async () => {
    const app = await createApp();
    const mine = await makeProfile("Petur");
    const theirs = await makeProfile("Mira");
    const { book, doc } = await makeDocument(mine.id);
    const bilingual = await makeDocument(mine.id, { bookId: book.id, format: "epub-bilingual", language: "English" });
    await makeDocument(mine.id, { format: "pdf" });
    await makeDocument(mine.id, { shelfHidden: true });
    await makeDocument(theirs.id);
    const { deviceId, deviceKey } = await pair(app, mine.id);

    const res = await app.inject({ method: "GET", url: "/shelf", headers: { authorization: `Bearer ${deviceKey}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile).toEqual({ id: mine.id, name: "Petur" });
    expect(body.device).toEqual({ id: deviceId, name: "Petur's iPhone" });
    expect(body.books).toHaveLength(1);
    expect(body.books[0]).toMatchObject({ id: book.id, title: "Der Prozess", author: "Kafka", language: "German", source: "Project Gutenberg", rights: "Public domain" });
    expect(body.books[0].editions.map((e: { documentId: string; label: string; downloaded: boolean }) => [e.documentId, e.label, e.downloaded])).toEqual([
      [bilingual.doc.id, "German and English", false],
      [doc.id, "German, read-along", false],
    ]);
  });

  it("downloads a file once per phone in the owner's count, and never a hidden or foreign one", async () => {
    const app = await createApp();
    const mine = await makeProfile("Petur");
    const theirs = await makeProfile("Mira");
    const { doc } = await makeDocument(mine.id);
    const hidden = await makeDocument(mine.id, { shelfHidden: true });
    const foreign = await makeDocument(theirs.id);
    const { deviceId, deviceKey } = await pair(app, mine.id);
    const auth = { authorization: `Bearer ${deviceKey}` };

    expect((await app.inject({ method: "GET", url: `/shelf/documents/${doc.id}` })).statusCode).toBe(401);
    const res = await app.inject({ method: "GET", url: `/shelf/documents/${doc.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/epub+zip");
    expect(res.headers["content-disposition"]).toContain("attachment");
    // The reader streams the file and sizes its progress bar from this
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength("PK\u0003\u0004 not really an epub"));
    expect(res.body).toContain("not really an epub");
    await app.inject({ method: "GET", url: `/shelf/documents/${doc.id}`, headers: auth });
    const downloads = await getDb().select().from(shelfDownloads).where(eq(shelfDownloads.deviceId, deviceId));
    expect(downloads.map((d) => d.documentId)).toEqual([doc.id]);

    expect((await app.inject({ method: "GET", url: `/shelf/documents/${hidden.doc.id}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/shelf/documents/${foreign.doc.id}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/shelf/documents/not-a-uuid", headers: auth })).statusCode).toBe(400);

    const shelf = await app.inject({ method: "GET", url: "/shelf", headers: auth });
    expect(shelf.json().books[0].editions[0].downloaded).toBe(true);
  });

  it("does not count a download whose file is missing", async () => {
    const app = await createApp();
    const { doc } = await makeDocument(DEFAULT_PROFILE_ID);
    await rm(doc.outputPath);
    const { deviceId, deviceKey } = await pair(app, DEFAULT_PROFILE_ID);
    const res = await app.inject({ method: "GET", url: `/shelf/documents/${doc.id}`, headers: { authorization: `Bearer ${deviceKey}` } });
    expect(res.statusCode).toBe(404);
    expect(await getDb().select().from(shelfDownloads).where(eq(shelfDownloads.deviceId, deviceId))).toEqual([]);
  });
});
