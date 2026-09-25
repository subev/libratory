import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { getDb, resetDb } from "../test/setup.ts";
import { books, DEFAULT_PROFILE_ID } from "./schema.ts";

vi.mock("./db.ts", async () => {
  const { getDb } = await import("../test/setup.ts");
  return { get db() { return getDb(); } };
});

const resolveLlm = vi.fn();
vi.mock("./lib/llm.ts", async (original) => ({ ...(await original<typeof import("./lib/llm.ts")>()), resolveLlm: (key?: string) => resolveLlm(key) }));

const searchLibrary = vi.fn();
vi.mock("./lib/search.ts", async (original) => ({ ...(await original<typeof import("./lib/search.ts")>()), searchLibrary: (opts: unknown) => searchLibrary(opts) }));

import { FINAL_STEP_MESSAGE, registerChatRoutes } from "./chat-routes.ts";
import { createConversation, isChatRunning, liveAnswer, loadMessages, sourcesOf, stopChatRun } from "./lib/chats.ts";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = (unified: "stop" | "tool-calls") => ({ type: "finish" as const, finishReason: { unified, raw: unified }, usage });
const streamOf = (parts: unknown[], hold: AbortSignal | null) =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      // Held open: the answer is mid-sentence until it is stopped, and then it ends the way a
      // provider's connection does
      if (!hold) controller.close();
      else hold.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });

// One search, then an answer that cites what the search found
function citingModel(answer: string, hold = false) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      step += 1;
      const parts = step === 1
        ? [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "t1", toolName: "search_library", input: JSON.stringify({ query: "voyage" }) }, finish("tool-calls")]
        : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: answer }, ...(hold ? [] : [{ type: "text-end", id: "a" }, finish("stop")])];
      return { stream: streamOf(parts, hold && step > 1 ? (abortSignal ?? null) : null) } as never;
    },
  });
}

const def = { key: "test", label: "Test model", supportsTools: true, supportsTemperature: true, contextTokens: 100_000 };

async function setup() {
  const bookId = crypto.randomUUID();
  await getDb().insert(books).values({ id: bookId, title: "Moby-Dick", filename: "m.pdf", pdfPath: "/tmp/m.pdf" });
  searchLibrary.mockResolvedValue({
    mode: "keyword",
    hits: [{ chunkId: crypto.randomUUID(), source: "raw", bookId, bookTitle: "Moby-Dick", bookFileId: null, chapterFileId: null, pageStart: 3, pageEnd: 3, chapterId: null, chapterTitle: null, chapterIndex: null, language: null, text: "Call me Ishmael." }],
  });
  const id = await createConversation(DEFAULT_PROFILE_ID, { kind: "library" }, null);
  const app = Fastify();
  registerChatRoutes(app);
  // The response can end a moment before the answer is kept; a test reads the table, so it waits for the run
  const post = async (body: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url: "/chat", payload: { conversationId: id, ...body } });
    await vi.waitFor(() => expect(isChatRunning(id)).toBe(false));
    return response;
  };
  const postWithoutWaiting = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/chat", payload: { conversationId: id, ...body } });
  return { id, post, postWithoutWaiting };
}

const transcript = async (id: string) => (await loadMessages(id)).map((m) => [m.role, m.metadata?.status, m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")]);

describe("POST /chat", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    resolveLlm.mockReset();
    searchLibrary.mockReset();
  });

  it("keeps the question and the answer with its verified sources", async () => {
    const { id, post } = await setup();
    resolveLlm.mockResolvedValue({ model: citingModel("It begins at sea [c_1] and not [c_9]."), def });

    const response = await post({ text: "How does it begin?" });
    expect(response.statusCode).toBe(200);
    expect(await transcript(id)).toEqual([["user", "complete", "How does it begin?"], ["assistant", "complete", "It begins at sea [c_1] and not [c_9]."]]);
    const [, answer] = await loadMessages(id);
    expect(sourcesOf(answer!.parts).map((s) => s.id)).toEqual(["c_1"]);
    expect(isChatRunning(id)).toBe(false);
  });

  it("a model that searches on every step is handed no tools on the last one, and told to answer", async () => {
    const { id, post } = await setup();
    const calls: { tools: number; last: unknown }[] = [];
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ tools, prompt }) => {
        step += 1;
        calls.push({ tools: tools?.length ?? 0, last: prompt.at(-1) });
        // With tools on offer it searches; without them it answers
        const parts = tools?.length
          ? [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: `t${step}`, toolName: "search_library", input: JSON.stringify({ query: `try ${step}` }) }, finish("tool-calls")]
          : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: "Not in the library [c_1]." }, { type: "text-end", id: "a" }, finish("stop")];
        return { stream: streamOf(parts, null) } as never;
      },
    });
    resolveLlm.mockResolvedValue({ model, def });

    const response = await post({ text: "Is there a song about Nikola?" });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(8);
    expect(calls.slice(0, 7).every((c) => c.tools === 3)).toBe(true);
    expect(calls[7]).toMatchObject({ tools: 0, last: { role: "user", content: [{ type: "text", text: FINAL_STEP_MESSAGE }] } });
    expect(await transcript(id)).toEqual([["user", "complete", "Is there a song about Nikola?"], ["assistant", "complete", "Not in the library [c_1]."]]);
  });

  it("retrying a question that was refused answers that question, once, and leaves the earlier answer alone", async () => {
    const { id, post } = await setup();
    resolveLlm.mockResolvedValue({ model: citingModel("First answer [c_1]."), def });
    await post({ text: "First?" });

    // Refused before it was saved: the model cannot be reached
    resolveLlm.mockRejectedValueOnce(new Error("provider is down"));
    expect((await post({ text: "Second?" })).statusCode).toBe(503);
    expect(await transcript(id)).toHaveLength(2);

    // Ask again, as the page sends it: a regenerate naming the second question
    resolveLlm.mockResolvedValue({ model: citingModel("Second answer [c_1]."), def });
    expect((await post({ trigger: "regenerate", text: "Second?", question: 2 })).statusCode).toBe(200);
    expect(await transcript(id)).toEqual([
      ["user", "complete", "First?"], ["assistant", "complete", "First answer [c_1]."],
      ["user", "complete", "Second?"], ["assistant", "complete", "Second answer [c_1]."],
    ]);
  });

  it("a stopped answer keeps its words, its ending and the sources of what it had cited", async () => {
    const { id, postWithoutWaiting } = await setup();
    resolveLlm.mockResolvedValue({ model: citingModel("It begins at sea [c_1], and then", true), def });

    const pending = postWithoutWaiting({ text: "How does it begin?" });
    await vi.waitFor(() => expect(JSON.stringify(liveAnswer(id)?.parts ?? [])).toContain("and then"), { timeout: 5000 });
    expect(await stopChatRun(id)).toBe(true);
    await pending;

    const [, answer] = await loadMessages(id);
    expect(answer?.metadata?.status).toBe("stopped");
    expect(JSON.stringify(answer?.parts)).toContain("It begins at sea [c_1], and then");
    expect(sourcesOf(answer!.parts).map((s) => [s.id, s.bookTitle, s.page])).toEqual([["c_1", "Moby-Dick", 3]]);
    expect(isChatRunning(id)).toBe(false);
  });

  it("refuses a second question while the first is still being answered", async () => {
    const { id, postWithoutWaiting } = await setup();
    resolveLlm.mockResolvedValue({ model: citingModel("Still writing [c_1]", true), def });

    const pending = postWithoutWaiting({ text: "First?" });
    await vi.waitFor(() => expect(isChatRunning(id)).toBe(true));
    expect((await postWithoutWaiting({ text: "Second?" })).statusCode).toBe(409);
    expect((await transcript(id)).map((m) => m[2])).toEqual(["First?"]);

    await stopChatRun(id);
    await pending;
  });
});
