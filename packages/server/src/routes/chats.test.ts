import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, resetDb } from "../../test/setup.ts";
import { books, chatConversations, chatMessages, folders, profiles } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { chatsRouter } from "./chats.ts";
import {
  appendQuestion,
  claimChatRun,
  getConversation,
  loadMessages,
  messagesForModel,
  releaseChatRun,
  resolveScope,
  retryQuestion,
  saveAnswer,
  searchScopeOf,
  titleFromQuestion,
} from "../lib/chats.ts";
import { DEFAULT_PROFILE_ID } from "../schema.ts";

const caller = chatsRouter.createCaller({});

async function insertBook(title: string, profileId = DEFAULT_PROFILE_ID) {
  const id = crypto.randomUUID();
  await getDb().insert(books).values({ id, title, filename: "b.pdf", pdfPath: "/tmp/b.pdf", profileId });
  return id;
}

const source = (bookId: string, bookTitle: string) => ({
  id: "c_1", chunkId: crypto.randomUUID(), kind: "raw" as const, bookId, bookTitle,
  fileId: null, page: 3, chapterId: null, chapterTitle: null, language: null,
});

async function ask(id: string, question: string) {
  const conversation = await getConversation(DEFAULT_PROFILE_ID, id);
  if (!conversation) throw new Error("conversation missing");
  await appendQuestion(conversation, question, "flash");
}

const answer = (conversationId: string, parts: unknown[], status: "complete" | "stopped" | "failed" = "complete") =>
  saveAnswer({ conversationId, parts, status, error: status === "failed" ? "boom" : null, model: "flash", modelLabel: "Flash" });

describe("chat conversations", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("names a conversation after its first question and hides one that was never asked", async () => {
    const asked = await caller.create({ scope: { kind: "library" } });
    await caller.create({ scope: { kind: "library" } });
    await ask(asked.id, "How does the voyage begin?");
    await ask(asked.id, "And how does it end?");

    const list = await caller.list();
    expect(list.map((c) => c.title)).toEqual(["How does the voyage begin?"]);
  });

  it("cuts a long first question at a word", () => {
    const title = titleFromQuestion(`${"word ".repeat(40)}end`);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/wor…$/);
  });

  it("restores messages, citations and the way each answer ended", async () => {
    const bookId = await insertBook("Moby-Dick");
    const { id } = await caller.create({ scope: { kind: "books", bookIds: [bookId] } });
    await ask(id, "Who is Ishmael?");
    await answer(id, [{ type: "text", text: "A sailor [c_1]." }, { type: "data-sources", data: [source(bookId, "Moby-Dick")] }]);
    await ask(id, "And Ahab?");
    await answer(id, [{ type: "text", text: "The capt" }], "stopped");

    const opened = await caller.get({ id });
    expect(opened?.messages.map((m) => [m.role, m.metadata.status])).toEqual([
      ["user", "complete"], ["assistant", "complete"], ["user", "complete"], ["assistant", "stopped"],
    ]);
    expect(opened?.messages[1]?.parts).toHaveLength(2);
    expect(opened?.scope).toEqual({ kind: "books", books: [{ id: bookId, title: "Moby-Dick", available: true }] });
  });

  it("records the books an answer quoted, so a whole-library chat can be found by book", async () => {
    const bookId = await insertBook("Moby-Dick");
    const { id } = await caller.create({ scope: { kind: "library" } });
    await ask(id, "Which books mention whales?");
    await answer(id, [{ type: "text", text: "One [c_1]." }, { type: "data-sources", data: [source(bookId, "Moby-Dick")] }]);

    const [conversation] = await caller.list();
    expect(conversation?.scope).toEqual({ kind: "library" });
    expect(conversation?.citedBooks).toEqual([{ id: bookId, title: "Moby-Dick", available: true }]);
    expect(conversation?.answers).toBe(1);
  });

  it("keeps a removed book readable by its snapshot title and never widens the search", async () => {
    const kept = await insertBook("Kept");
    const gone = await insertBook("Gone");
    const both = await caller.create({ scope: { kind: "books", bookIds: [kept, gone] } });
    const onlyGone = await caller.create({ scope: { kind: "books", bookIds: [gone] } });
    await getDb().delete(books).where(eq(books.id, gone));

    const bothScope = (await caller.get({ id: both.id }))?.scope;
    expect(bothScope).toEqual({ kind: "books", books: [{ id: kept, title: "Kept", available: true }, { id: gone, title: "Gone", available: false }] });
    expect(searchScopeOf(DEFAULT_PROFILE_ID, bothScope!)).toEqual({ profileId: DEFAULT_PROFILE_ID, bookIds: [kept] });

    const goneScope = (await caller.get({ id: onlyGone.id }))?.scope;
    expect(searchScopeOf(DEFAULT_PROFILE_ID, goneScope!)).toBeNull();
  });

  it("refuses a removed folder rather than searching the library", async () => {
    const folderId = crypto.randomUUID();
    await getDb().insert(folders).values({ id: folderId, name: "Russian" });
    const { id } = await caller.create({ scope: { kind: "folder", folderId } });
    await getDb().delete(folders).where(eq(folders.id, folderId));

    const conversation = await getConversation(DEFAULT_PROFILE_ID, id);
    const scope = await resolveScope(DEFAULT_PROFILE_ID, conversation!.scope);
    expect(scope).toEqual({ kind: "folder", folderId, name: "Russian", available: false });
    expect(searchScopeOf(DEFAULT_PROFILE_ID, scope)).toBeNull();
  });

  it("keeps conversations and books inside their profile", async () => {
    const otherProfile = crypto.randomUUID();
    await getDb().insert(profiles).values({ id: otherProfile, name: "Other" });
    const foreignBook = await insertBook("Foreign", otherProfile);
    const { id } = await caller.create({ scope: { kind: "library" } });
    await ask(id, "Mine");

    const other = chatsRouter.createCaller({ profileId: otherProfile });
    expect(await other.list()).toEqual([]);
    expect(await other.get({ id })).toBeNull();
    await expect(other.delete({ id })).rejects.toThrow("not found");
    await other.rename({ id, title: "Hijacked" });
    expect((await caller.list())[0]?.title).toBe("Mine");
    await expect(caller.create({ scope: { kind: "books", bookIds: [foreignBook] } })).rejects.toThrow("at least one book");
  });

  it("asks again by dropping what followed the last question", async () => {
    const { id } = await caller.create({ scope: { kind: "library" } });
    await ask(id, "First?");
    await answer(id, [{ type: "text", text: "Yes." }]);
    await ask(id, "Second?");
    await answer(id, [{ type: "text", text: "Par" }], "failed");

    const conversation = (await getConversation(DEFAULT_PROFILE_ID, id))!;
    expect(await retryQuestion(conversation, { ordinal: 2, text: "Second?", model: "flash" })).toBe("regenerated");
    expect((await loadMessages(id)).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("retries a question that was refused before it was saved as that question, leaving the earlier answer alone", async () => {
    const { id } = await caller.create({ scope: { kind: "library" } });
    await ask(id, "First?");
    await answer(id, [{ type: "text", text: "Yes." }]);
    const conversation = (await getConversation(DEFAULT_PROFILE_ID, id))!;

    // The page holds a second question the server never saw: it is one past what is stored
    expect(await retryQuestion(conversation, { ordinal: 2, text: "Second?", model: "flash" })).toBe("submitted");
    const messages = await loadMessages(id);
    expect(messages.map((m) => [m.role, m.parts])).toEqual([
      ["user", [{ type: "text", text: "First?" }]],
      ["assistant", [{ type: "text", text: "Yes." }]],
      ["user", [{ type: "text", text: "Second?" }]],
    ]);

    // Saved now, so the same retry again regenerates rather than saving it twice
    expect(await retryQuestion(conversation, { ordinal: 2, text: "Second?", model: "flash" })).toBe("regenerated");
    expect((await loadMessages(id)).filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("retries a refused first question, and refuses a page that has fallen out of step", async () => {
    const { id } = await caller.create({ scope: { kind: "library" } });
    const conversation = (await getConversation(DEFAULT_PROFILE_ID, id))!;
    expect(await retryQuestion(conversation, { ordinal: 1, text: "", model: "flash" })).toBe("nothing-to-ask");
    expect(await retryQuestion(conversation, { ordinal: 1, text: "First?", model: "flash" })).toBe("submitted");
    expect((await caller.list())[0]?.title).toBe("First?");

    await answer(id, [{ type: "text", text: "Yes." }]);
    expect(await retryQuestion(conversation, { ordinal: 4, text: "Fourth?", model: "flash" })).toBe("out-of-step");
    expect((await loadMessages(id)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("a delete from another profile leaves the owner's running answer alone", async () => {
    const otherProfile = crypto.randomUUID();
    await getDb().insert(profiles).values({ id: otherProfile, name: "Other" });
    const { id } = await caller.create({ scope: { kind: "library" } });
    await ask(id, "Mine?");
    const run = claimChatRun(id)!;

    await expect(chatsRouter.createCaller({ profileId: otherProfile }).delete({ id })).rejects.toThrow("not found");
    expect(run.controller.signal.aborted).toBe(false);
    expect((await caller.list()).map((c) => c.id)).toEqual([id]);
    releaseChatRun(id, run);
  });

  it("knows a cited book is gone whatever the conversation searched", async () => {
    const cited = await insertBook("Cited");
    const folderId = crypto.randomUUID();
    await getDb().insert(folders).values({ id: folderId, name: "Shelf" });
    const opened = [];
    for (const scope of [{ kind: "library" as const }, { kind: "folder" as const, folderId }, { kind: "books" as const, bookIds: [cited] }]) {
      const { id } = await caller.create({ scope });
      await ask(id, "Where?");
      await answer(id, [{ type: "text", text: "There [c_1]." }, { type: "data-sources", data: [source(cited, "Cited")] }]);
      opened.push(id);
    }
    await getDb().delete(books).where(eq(books.id, cited));

    for (const id of opened) {
      const conversation = await caller.get({ id });
      expect(conversation?.removedBookIds).toEqual([cited]);
      // The transcript and the title it cited are kept
      expect(JSON.stringify(conversation?.messages[1]?.parts)).toContain("Cited");
    }
  });

  it("shows the model a cut-short answer's words but not its unanswered tool calls", async () => {
    const { id } = await caller.create({ scope: { kind: "library" } });
    await ask(id, "First?");
    await answer(id, [{ type: "tool-search_library", toolCallId: "t1", state: "input-available", input: { query: "x" } }, { type: "text", text: "Par" }], "stopped");
    await ask(id, "Second?");
    await answer(id, [{ type: "tool-search_library", toolCallId: "t2", state: "input-available", input: { query: "y" } }], "stopped");

    const forModel = messagesForModel(await loadMessages(id));
    expect(forModel.map((m) => m.parts.map((p) => p.type))).toEqual([["text"], ["text"], ["text"]]);
  });

  it("answers one question at a time per conversation", () => {
    const id = crypto.randomUUID();
    const run = claimChatRun(id);
    expect(run).not.toBeNull();
    expect(claimChatRun(id)).toBeNull();
    releaseChatRun(id, run!);
    expect(claimChatRun(id)).not.toBeNull();
  });

  it("stop returns only once the run has let go, so asking again is never refused", async () => {
    const { id } = await caller.create({ scope: { kind: "library" } });
    await ask(id, "Long one?");
    const run = claimChatRun(id)!;
    // The route's side of it: wind down on abort, keep the partial answer, release
    run.controller.signal.addEventListener("abort", () => {
      void answer(id, [{ type: "text", text: "Par" }], "stopped").then(() => releaseChatRun(id, run));
    });

    expect(await caller.stop({ id })).toEqual({ stopped: true });
    expect(claimChatRun(id)).not.toBeNull();
    expect((await caller.get({ id }))?.messages.at(-1)?.metadata.status).toBe("stopped");
    expect(await caller.stop({ id: (await caller.create({ scope: { kind: "library" } })).id })).toEqual({ stopped: false });
  });

  it("shows a window that opens mid-answer what has been written so far", async () => {
    const { id } = await caller.create({ scope: { kind: "library" } });
    await ask(id, "Still going?");
    const run = claimChatRun(id)!;
    run.latest = {
      id: "live", role: "assistant", parts: [{ type: "text", text: "So far" }],
      metadata: { status: "streaming", error: null, modelKey: "flash", modelLabel: "Flash", createdAt: new Date().toISOString() },
    };

    const during = await caller.get({ id });
    expect(during?.running).toBe(true);
    expect(during?.messages.map((m) => m.metadata.status)).toEqual(["complete", "streaming"]);

    await answer(id, [{ type: "text", text: "So far, and the rest." }]);
    releaseChatRun(id, run);
    const after = await caller.get({ id });
    expect(after?.running).toBe(false);
    expect(after?.messages.map((m) => m.metadata.status)).toEqual(["complete", "complete"]);
  });

  it("deleting a conversation stops its run, and a late answer does not bring it back", async () => {
    const { id } = await caller.create({ scope: { kind: "library" } });
    await ask(id, "Going?");
    const run = claimChatRun(id);

    await caller.delete({ id });
    expect(run?.controller.signal.aborted).toBe(true);
    await answer(id, [{ type: "text", text: "Too late" }], "stopped");

    expect(await getDb().select().from(chatConversations)).toEqual([]);
    expect(await getDb().select().from(chatMessages)).toEqual([]);
    releaseChatRun(id, run!);
  });
});
