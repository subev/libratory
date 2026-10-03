import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq, ne } from "drizzle-orm";

import { ensureGraphileTables, getDb, resetDb, row } from "../../test/setup.ts";
import { bilingualPreparations, books, chapters, chapterVariants, folders, notes, profiles, DEFAULT_PROFILE_ID } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

vi.mock("graphile-worker", () => ({ quickAddJob: vi.fn(async () => {}) }));
import { quickAddJob } from "graphile-worker";

import { createMcpServer } from "./mcp-server.ts";

async function connect(profileId = DEFAULT_PROFILE_ID) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([createMcpServer(profileId).connect(serverSide), client.connect(clientSide)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { type: string; text: string }[];
    if (result.isError) throw new Error(first?.text ?? "tool error");
    return JSON.parse(first?.text ?? "null");
  };
}

const chapter = (title: string) => ({
  title,
  text: `${title}. The kindergarten opens at seven in the morning and the children are met at the door by their teacher. ` +
    "Parents are asked to bring them before half past eight, because breakfast is served then and the day's activities begin right after it.",
});

beforeEach(async () => {
  await resetDb(getDb());
  // The variant routes clear a lane's queued jobs before requeueing, which reads the worker's tables
  await ensureGraphileTables(getDb());
});

describe("placing a book", () => {
  it("reaches a profile by name although the connection is the default one", async () => {
    const tedi = row(await getDb().insert(profiles).values({ name: "Tedi" }).returning());
    const call = await connect();

    const created = await call("create_book", { title: "Rules", chapters: [chapter("One")], profile: "tedi", folder: "School/Rules" });
    expect(created.chapters.total).toBe(1);
    expect(created.added).toHaveLength(1);

    const [book] = await getDb().select().from(books).where(eq(books.id, created.id));
    expect(book?.profileId).toBe(tedi.id);
    expect(book?.kind).toBe("api");
    expect(book?.language).toBe("en");

    const listed = await call("list_books", { profile: "Tedi" });
    expect(listed.profiles.find((p: { current: boolean }) => p.current).name).toBe("Tedi");
    expect(listed.folders.map((f: { path: string }) => f.path)).toEqual(["School", "School/Rules"]);
    expect(listed.books).toMatchObject([{ id: created.id, folder: "School/Rules", chapters: 1 }]);
    expect((await call("list_books")).books).toEqual([]);
  });

  it("reuses a folder path instead of creating it twice, and never creates one for a filter", async () => {
    const call = await connect();
    await call("create_book", { title: "A", chapters: [chapter("One")], folder: "Work" });
    await call("create_book", { title: "B", chapters: [chapter("One")], folder: "work" });
    expect(await getDb().select().from(folders)).toHaveLength(1);

    await expect(call("list_books", { folder: "Nowhere" })).rejects.toThrow(/the folders are: Work/);
    expect(await getDb().select().from(folders)).toHaveLength(1);
    await expect(call("list_books", { profile: "Nobody" })).rejects.toThrow(/the profiles are/);
  });

  it("appends to a book and moves it with set_book_settings", async () => {
    const call = await connect();
    const created = await call("create_book", { title: "Digest", chapters: [chapter("One")] });
    const appended = await call("create_book", { appendTo: created.id, chapters: [chapter("Two"), chapter("Three")] });
    expect(appended.chapters.total).toBe(3);
    expect(appended.added.map((c: { index: number }) => c.index)).toEqual([1, 2]);
    await expect(call("create_book", { chapters: [chapter("Orphan")] })).rejects.toThrow(/needs a title/);

    const moved = await call("set_book_settings", { id: created.id, title: "Weekly digest", folder: "Feeds" });
    expect(moved.title).toBe("Weekly digest");
    const [folder] = await getDb().select().from(folders);
    expect(moved.folderId).toBe(folder?.id);
    expect((await call("set_book_settings", { id: created.id, folder: null })).folderId).toBeNull();
  });

  it("cuts a long listing and says so", async () => {
    const call = await connect();
    for (const title of ["Alpha", "Beta", "Alphabet"]) await call("create_book", { title, chapters: [chapter("One")] });
    const cut = await call("list_books", { limit: 2 });
    expect(cut).toMatchObject({ totalBooks: 3, truncated: true });
    expect(cut.books).toHaveLength(2);
    const found = await call("list_books", { query: "alpha" });
    expect(found.books.map((b: { title: string }) => b.title).sort()).toEqual(["Alpha", "Alphabet"]);
  });
});

describe("finding a book", () => {
  it("names the copies in other profiles and leaves the folder list out of a search", async () => {
    const tedi = row(await getDb().insert(profiles).values({ name: "Tedi" }).returning());
    const call = await connect();
    await call("create_book", { title: "Frankenstein", chapters: [chapter("One")], folder: "Classics" });
    const theirs = await call("create_book", { title: "Frankenstein (1888)", chapters: [chapter("One")], profile: "Tedi" });

    const found = await call("list_books", { query: "frankenstein" });
    expect(found.books).toHaveLength(1);
    expect(found).not.toHaveProperty("folders");
    expect(found.elsewhere).toEqual([{ id: theirs.id, title: "Frankenstein (1888)", profile: "Tedi" }]);
    // Naming a profile asks about that one alone
    expect(await call("list_books", { query: "frankenstein", profile: tedi.id })).not.toHaveProperty("elsewhere");
    expect((await call("list_books")).folders).toHaveLength(1);
  });
});

describe("notes", () => {
  it("saves on a book and in the library, and reads them back", async () => {
    const call = await connect();
    const book = await call("create_book", { title: "Rules", chapters: [chapter("One")] });
    const onBook = await call("save_note", { title: "When does it open?", markdown: "At **seven** (ch. One).", bookId: book.id, author: "claude-code" });
    await call("save_note", { title: "Across the library", markdown: "Nothing else mentions it." });

    expect(await call("list_notes", { bookId: book.id })).toMatchObject([{ id: onBook.noteId, title: "When does it open?", author: "claude-code" }]);
    expect(await call("list_notes")).toMatchObject([{ bookId: null, title: "Across the library", author: "agent" }]);
    expect(await call("list_notes", { noteId: onBook.noteId })).toMatchObject({ text: "At **seven** (ch. One).", truncated: false });
    expect((await call("get_book", { id: book.id })).notes).toHaveLength(1);

    const [saved] = await getDb().select().from(notes).where(eq(notes.id, onBook.noteId));
    expect(saved?.profileId).toBe(DEFAULT_PROFILE_ID);
    await expect(call("save_note", { title: "x", markdown: "y", bookId: crypto.randomUUID() })).rejects.toThrow(/Book not found/);
  });
});

describe("get_book", () => {
  it("lists chapters with ids while the action tools answer with counts", async () => {
    const call = await connect();
    const created = await call("create_book", { title: "Rules", chapters: [chapter("One"), chapter("Two")] });
    expect(created.chapters).not.toHaveProperty("0");

    const full = await call("get_book", { id: created.id, logs: true });
    const rows = await getDb().select().from(chapters).where(eq(chapters.bookId, created.id));
    expect(full.chapters.map((c: { id: string }) => c.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(full.logs.length).toBeGreaterThan(0);
    expect(await call("get_book", { id: created.id })).not.toHaveProperty("logs");

    const polled = await call("get_book", { id: created.id, logsOnly: true });
    expect(polled).not.toHaveProperty("chapters");
    expect(polled.logs.length).toBeGreaterThan(0);
    // No recording yet, so nothing to say about its word times
    expect(full.chapters.map((c: { wordTiming: boolean | null }) => c.wordTiming)).toEqual([null, null]);
  });
});

describe("a translation and its export", () => {
  it("reads a chapter's translation and exports only the named chapters", async () => {
    const call = await connect();
    const created = await call("create_book", { title: "Rules", chapters: [chapter("One"), chapter("Two")] });
    const [one, two] = (await call("get_book", { id: created.id })).chapters as { id: string }[];
    await call("translate_book", { id: created.id, language: "German", chapterIds: [one!.id] });
    await getDb().update(chapterVariants).set({ status: "done", text: "Der Kindergarten öffnet um sieben." }).where(eq(chapterVariants.chapterId, one!.id));

    expect(await call("get_chapter", { id: one!.id, language: "german" })).toMatchObject({ language: "German", status: "done", text: "Der Kindergarten öffnet um sieben." });
    await expect(call("get_chapter", { id: two!.id, language: "German" })).rejects.toThrow(/has no German version/);
    expect((await call("get_book", { id: created.id })).variants[0].chapterIndexes).toEqual([0]);

    const bilingual = { sourceAudio: false, targetAudio: false };
    await expect(call("export_book", { id: created.id, format: "epub-bilingual", language: "German", bilingual, chapterIds: [two!.id] }))
      .rejects.toThrow(`No finished German translation for 2. Two (${two!.id})`);
    await expect(call("export_book", { id: created.id, format: "epub-bilingual", language: "German", bilingual, chapterIds: [one!.id] }))
      .rejects.toThrow(/Not paired yet: 1. One .* prepare_bilingual stage "pairs"/);

    vi.mocked(quickAddJob).mockClear();
    const exported = await call("export_book", { id: created.id, format: "epub", chapterIds: [two!.id] });
    expect(exported.next).toBe('wait_for_book until "document"');
    expect(vi.mocked(quickAddJob)).toHaveBeenCalledWith(expect.anything(), "assembleDocument", expect.objectContaining({ chapterIds: [two!.id] }), expect.anything());
    // Another chapter's export is another document, not a replacement of the first job
    await call("export_book", { id: created.id, format: "epub", chapterIds: [one!.id] });
    const keys = vi.mocked(quickAddJob).mock.calls.map(([, , , spec]) => spec?.jobKey);
    expect(new Set(keys).size).toBe(2);
    await expect(call("export_book", { id: created.id, format: "epub", chapterIds: [crypto.randomUUID()] })).rejects.toThrow(/not in this book/);
  });

  it("adds up what the word links cost and says how far a run has got", async () => {
    const call = await connect();
    const created = await call("create_book", { title: "Rules", chapters: [chapter("One")] });
    await call("translate_book", { id: created.id, language: "German" });
    const [variant] = await getDb().update(chapterVariants).set({ status: "done", text: "Der Kindergarten öffnet um sieben." }).returning();
    const batch = { pairIds: ["p1"], model: "flash", raw: "", error: null, inputTokens: 1200, outputTokens: 300 };
    await getDb().insert(bilingualPreparations).values({
      variantId: variant!.id,
      links: { pairRevision: "r1", promptVersion: "v1", byPair: {}, batches: [batch, { ...batch, error: "Token 438 is not in the target sentence" }] },
      linkJob: { status: "running", runId: "run", model: "flash", done: 3, total: 8, error: null, updatedAt: new Date().toISOString() },
    });

    const lane = (await call("get_book", { id: created.id })).bilingual[0];
    // The failed batch was billed too
    expect(lane.linkSpend).toEqual({ batches: 2, inputTokens: 2400, outputTokens: 600, models: ["flash"] });

    const waited = await call("wait_for_book", { id: created.id, until: "bilingual", language: "German", timeoutSeconds: 1 });
    expect(waited).toMatchObject({ satisfied: false, reason: "timeout", inProgress: ["One (links): 3/8 batches"] });
  });

  it("prices a metered narration without queueing it or changing the lane's voice", async () => {
    const call = await connect();
    const created = await call("create_book", { title: "Rules", chapters: [chapter("One")] });
    const [one] = (await call("get_book", { id: created.id })).chapters as { id: string }[];
    await call("translate_book", { id: created.id, language: "German" });
    await getDb().update(chapterVariants).set({ status: "done", text: "Der Kindergarten öffnet um sieben." }).where(eq(chapterVariants.chapterId, one!.id));
    vi.mocked(quickAddJob).mockClear();

    const voice = "cartesia:fcbecbcc-0cef-4615-8b5a-712fe1b39dd0";
    const priced = await call("synthesize_book", { id: created.id, language: "German", voice, dryRun: true });
    expect(priced).toEqual({ dryRun: true, estimate: { voice, engine: "Cartesia", characters: 34, billing: "Cartesia bills about one credit per character" } });
    expect(vi.mocked(quickAddJob)).not.toHaveBeenCalled();
    const [book] = await getDb().select().from(books).where(eq(books.id, created.id));
    expect(book?.variantVoices ?? {}).toEqual({});
    // A local voice bills nothing
    expect((await call("synthesize_book", { id: created.id, dryRun: true })).estimate).toMatchObject({ metered: false });
  });
});

describe("translate_book", () => {
  it("queues a translation of the selected chapters and lists it under the book's variants", async () => {
    const call = await connect();
    const created = await call("create_book", { title: "Rules", chapters: [chapter("One"), chapter("Two")] });

    const queued = await call("translate_book", { id: created.id, language: "german" });
    expect(queued.key).toBe("German");
    expect(queued.queued).toBe(2);
    expect(queued.variants).toEqual([
      { key: "German", kind: "translation", label: null, chapters: { total: 2, done: 0, running: 2, failed: 0 }, error: null, failedAt: null, withAudio: 0, narrating: 0, audioFailed: 0, audioError: null, audioFailedAt: null },
    ]);
    expect((await call("get_book", { id: created.id })).variants).toHaveLength(1);

    // Another spelling joins the version that exists rather than opening a second one
    await getDb().update(chapterVariants).set({ status: "done" }).where(eq(chapterVariants.key, "German"));
    await expect(call("translate_book", { id: created.id, language: "GERMAN" })).rejects.toThrow(/No selected chapters need "German"/);
    expect((await call("translate_book", { id: created.id, language: "chinese (simplified)" })).key).toBe("Chinese (Simplified)");
  });

  it("refuses a language code, and anything but one target", async () => {
    const call = await connect();
    const created = await call("create_book", { title: "Rules", chapters: [chapter("One")] });
    await expect(call("translate_book", { id: created.id, language: "de" })).rejects.toThrow(/English name/);
    await expect(call("translate_book", { id: created.id })).rejects.toThrow(/exactly one/);
    await expect(call("translate_book", { id: created.id, language: "German", preset: "summary" })).rejects.toThrow(/exactly one/);
  });

  it("rewrites only the named chapters, with a preset or a prompt", async () => {
    const call = await connect();
    const created = await call("create_book", { title: "Rules", chapters: [chapter("One"), chapter("Two")] });
    const [first] = (await call("get_book", { id: created.id })).chapters as { id: string }[];

    const summary = await call("translate_book", { id: created.id, preset: "summary", chapterIds: [first!.id] });
    expect(summary.key).toBe("summary");
    expect(summary.queued).toBe(1);

    const rhymed = await call("translate_book", { id: created.id, prompt: "Rewrite it in rhyming couplets.", label: "Rhymed" });
    expect(rhymed.key).toBe("custom-rhymed");
    expect(rhymed.queued).toBe(2);
    const lanes = rhymed.variants as { key: string; kind: string; label: string | null; chapters: { total: number } }[];
    expect(lanes.map((l) => [l.key, l.kind, l.label, l.chapters.total])).toEqual([
      ["summary", "transform", "Summary", 1],
      ["custom-rhymed", "transform", "Rhymed", 2],
    ]);

    // A finished or queued chapter is not rewritten again unless it is named; a failed one is
    await getDb().update(chapterVariants).set({ status: "done" }).where(eq(chapterVariants.chapterId, first!.id));
    await expect(call("translate_book", { id: created.id, prompt: "Rewrite it in rhyming couplets.", label: "rhymed" })).rejects.toThrow(/already has "rhymed"/);
    await getDb().update(chapterVariants).set({ status: "failed" }).where(and(eq(chapterVariants.key, "custom-rhymed"), ne(chapterVariants.chapterId, first!.id)));
    expect((await call("translate_book", { id: created.id, prompt: "Rewrite it in rhyming couplets.", label: "rhymed" })).queued).toBe(1);
    // The preset path is the router's: the chapter without a summary gets one, then nothing is left to queue
    expect((await call("translate_book", { id: created.id, preset: "summary" })).queued).toBe(1);
    await expect(call("translate_book", { id: created.id, preset: "summary" })).rejects.toThrow(/No selected chapters need/);
    expect((await call("translate_book", { id: created.id, preset: "summary", chapterIds: [first!.id] })).queued).toBe(1);
  });
});
