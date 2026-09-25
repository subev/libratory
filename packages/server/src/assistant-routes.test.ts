import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { getDb, resetDb } from "../test/setup.ts";
import { books, chapters, DEFAULT_PROFILE_ID } from "./schema.ts";

vi.mock("./db.ts", async () => {
  const { getDb } = await import("../test/setup.ts");
  return { get db() { return getDb(); } };
});

const resolveLlm = vi.fn();
vi.mock("./lib/llm.ts", async (original) => ({ ...(await original<typeof import("./lib/llm.ts")>()), resolveLlm: (key?: string) => resolveLlm(key) }));

const searchLibrary = vi.fn();
vi.mock("./lib/search.ts", async (original) => ({ ...(await original<typeof import("./lib/search.ts")>()), searchLibrary: (opts: unknown) => searchLibrary(opts) }));

import { eq } from "drizzle-orm";
import { FINAL_STEP_MESSAGE, registerAssistantRoutes } from "./assistant-routes.ts";
import { createConversation, isChatRunning, liveAnswer, loadMessages, sourcesOf, stopChatRun, type ToolPartLike } from "./lib/chats.ts";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = (unified: "stop" | "tool-calls") => ({ type: "finish" as const, finishReason: { unified, raw: unified }, usage });
const streamOf = (parts: unknown[], hold: AbortSignal | null = null) =>
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

// Looks the library up, then answers with what it found
function lookingModel(answer: (toolResult: string) => string) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      step += 1;
      if (step === 1) {
        return { stream: streamOf([{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "t1", toolName: "list_books", input: "{}" }, finish("tool-calls")]) } as never;
      }
      const last = prompt.at(-1);
      const result = last?.role === "tool" ? JSON.stringify(last.content) : "";
      return { stream: streamOf([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: answer(result) }, { type: "text-end", id: "a" }, finish("stop")]) } as never;
    },
  });
}

const def = { key: "test", label: "Test model", supportsTools: true, supportsTemperature: true, contextTokens: 100_000 };

// One scripted answer per model call: a tool call (or several at once), or text
type Call = { tool: string; input: Record<string, unknown> };
type Step = Call | { calls: Call[] } | { text: string };
function scriptedModel(steps: Step[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[call++];
      if (!step) throw new Error("the script ran out");
      const calls = "calls" in step ? step.calls : "tool" in step ? [step] : [];
      const parts = calls.length > 0
        ? [{ type: "stream-start", warnings: [] }, ...calls.map((c, i) => ({ type: "tool-call", toolCallId: `t${call}-${i}`, toolName: c.tool, input: JSON.stringify(c.input) })), finish("tool-calls")]
        : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: "text" in step ? step.text : "" }, { type: "text-end", id: "a" }, finish("stop")];
      return { stream: streamOf(parts) } as never;
    },
  });
}

const toolParts = (message: { parts: unknown[] } | undefined) => (message?.parts ?? []).filter((p): p is ToolPartLike => (p as ToolPartLike).type === "dynamic-tool");

async function setup() {
  const bookId = crypto.randomUUID();
  await getDb().insert(books).values({ id: bookId, title: "Moby-Dick", filename: "m.pdf", pdfPath: "/tmp/m.pdf" });
  searchLibrary.mockResolvedValue({
    mode: "keyword",
    hits: [{ chunkId: crypto.randomUUID(), source: "raw", bookId, bookTitle: "Moby-Dick", bookFileId: null, chapterFileId: null, pageStart: 3, pageEnd: 3, chapterId: null, chapterTitle: null, chapterIndex: null, language: null, text: "Call me Ishmael." }],
  });
  const id = await createConversation(DEFAULT_PROFILE_ID, { kind: "library" }, null);
  const app = Fastify();
  registerAssistantRoutes(app);
  const postWithoutWaiting = (url: "/assistant" | "/assistant/undo", body: Record<string, unknown>) =>
    app.inject({ method: "POST", url, payload: { conversationId: id, screen: { route: "/" }, ...body } });
  // The response can end a moment before the answer is kept; a test reads the table, so it waits for the run.
  // Longer than the default second: under the whole suite the MCP hand-off and the model take their time
  const post = async (url: "/assistant" | "/assistant/undo", body: Record<string, unknown>) => {
    const response = await postWithoutWaiting(url, body);
    await vi.waitFor(() => expect(isChatRunning(id)).toBe(false), { timeout: 10_000 });
    return response;
  };
  return { id, bookId, post, postWithoutWaiting };
}

const transcript = async (id: string) => (await loadMessages(id)).map((m) => [m.role, m.metadata?.status, m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")]);

const bookTitle = async (bookId: string) => (await getDb().select({ title: books.title, voice: books.voice }).from(books).where(eq(books.id, bookId)))[0];

describe("POST /assistant", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    resolveLlm.mockReset();
    searchLibrary.mockReset();
  });

  it("keeps the question and the answer with its verified sources", async () => {
    const { id, post } = await setup();
    resolveLlm.mockResolvedValue({ model: citingModel("It begins at sea [c_1] and not [c_9]."), def });

    expect((await post("/assistant", { text: "How does it begin?" })).statusCode).toBe(200);
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
        return { stream: streamOf(parts) } as never;
      },
    });
    resolveLlm.mockResolvedValue({ model, def });

    expect((await post("/assistant", { text: "Is there a song about Nikola?" })).statusCode).toBe(200);
    expect(calls).toHaveLength(6);
    expect(calls.slice(0, 5).every((c) => c.tools > 0)).toBe(true);
    expect(calls[5]).toMatchObject({ tools: 0, last: { role: "user", content: [{ type: "text", text: FINAL_STEP_MESSAGE }] } });
    expect(await transcript(id)).toEqual([["user", "complete", "Is there a song about Nikola?"], ["assistant", "complete", "Not in the library [c_1]."]]);
  });

  it("retrying a question that was refused answers that question, once, and leaves the earlier answer alone", async () => {
    const { id, post } = await setup();
    resolveLlm.mockResolvedValue({ model: citingModel("First answer [c_1]."), def });
    await post("/assistant", { text: "First?" });

    // Refused before it was saved: the model cannot be reached
    resolveLlm.mockRejectedValueOnce(new Error("provider is down"));
    expect((await post("/assistant", { text: "Second?" })).statusCode).toBe(503);
    expect(await transcript(id)).toHaveLength(2);

    // Ask again, as the panel sends it: a regenerate naming the second question
    resolveLlm.mockResolvedValue({ model: citingModel("Second answer [c_1]."), def });
    expect((await post("/assistant", { trigger: "regenerate", text: "Second?", question: 2 })).statusCode).toBe(200);
    expect(await transcript(id)).toEqual([
      ["user", "complete", "First?"], ["assistant", "complete", "First answer [c_1]."],
      ["user", "complete", "Second?"], ["assistant", "complete", "Second answer [c_1]."],
    ]);
  });

  it("a stopped answer keeps its words, its ending and the sources of what it had cited", async () => {
    const { id, postWithoutWaiting } = await setup();
    resolveLlm.mockResolvedValue({ model: citingModel("It begins at sea [c_1], and then", true), def });

    const pending = postWithoutWaiting("/assistant", { text: "How does it begin?" });
    await vi.waitFor(() => expect(JSON.stringify(liveAnswer(id)?.parts ?? [])).toContain("and then"), { timeout: 10_000 });
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

    const pending = postWithoutWaiting("/assistant", { text: "First?" });
    await vi.waitFor(() => expect(isChatRunning(id)).toBe(true), { timeout: 10_000 });
    expect((await postWithoutWaiting("/assistant", { text: "Second?" })).statusCode).toBe(409);
    expect((await transcript(id)).map((m) => m[2])).toEqual(["First?"]);

    await stopChatRun(id);
    await pending;
  });

  it("answers from the library's own tools and keeps the call with the answer", async () => {
    const { id, post } = await setup();
    resolveLlm.mockResolvedValue({ model: lookingModel((found) => (found.includes("Moby-Dick") ? "You have Moby-Dick." : "Nothing found.")), def });

    const response = await post("/assistant", { text: "What do I have?" });
    expect(response.statusCode).toBe(200);
    const [question, answer] = await loadMessages(id);
    expect(question?.parts).toEqual([{ type: "text", text: "What do I have?" }]);
    expect(answer?.metadata?.status).toBe("complete");
    // MCP tools reach the stream as dynamic tools: the name is a field, not part of the type
    expect(answer?.parts.map((p) => (p.type === "dynamic-tool" ? `${p.type}:${p.toolName}:${p.state}` : p.type))).toEqual(["step-start", "dynamic-tool:list_books:output-available", "step-start", "text"]);
    expect(answer?.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).toEqual(["You have Moby-Dick."]);
  });

  it("names pinned text in the question with the ids analyze_text takes, titled from the library", async () => {
    const { id, bookId, post } = await setup();
    const chapterId = crypto.randomUUID();
    await getDb().insert(chapters).values({ id: chapterId, bookId, index: 0, title: "Loomings", rawText: "Call me Ishmael." });
    resolveLlm.mockResolvedValue({ model: lookingModel(() => "Read."), def });

    expect((await post("/assistant", { text: "Summarize", read: { bookId } })).statusCode).toBe(200);
    expect((await loadMessages(id))[0]?.parts).toEqual([{ type: "text", text: `Summarize\n\nRead the whole text of "Moby-Dick" (bookId ${bookId}).` }]);

    expect((await post("/assistant", { text: "Themes?", read: { bookId, chapterIds: [chapterId, crypto.randomUUID()] } })).statusCode).toBe(200);
    expect((await loadMessages(id))[2]?.parts).toEqual([{ type: "text", text: `Themes?\n\nRead this chapter of "Moby-Dick": "Loomings" (chapter ${chapterId}).` }]);

    // A book or chapters that are gone refuse the question rather than sending the model to look for them
    expect((await post("/assistant", { text: "x", read: { bookId: crypto.randomUUID() } })).statusCode).toBe(400);
    expect((await post("/assistant", { text: "x", read: { bookId, chapterIds: [crypto.randomUUID()] } })).statusCode).toBe(400);
  });

  it("runs a small edit at once and can undo it, without a model turn", async () => {
    const { id, bookId, post } = await setup();
    resolveLlm.mockResolvedValue({ model: scriptedModel([{ tool: "set_book_settings", input: { id: bookId, title: "Moby Dick, or The Whale" } }, { text: "Renamed." }]), def });
    expect((await post("/assistant", { text: "Give it its full title" })).statusCode).toBe(200);
    expect((await bookTitle(bookId))?.title).toBe("Moby Dick, or The Whale");
    const [, answer] = await loadMessages(id);
    const [call] = toolParts(answer);
    expect(call?.state).toBe("output-available");
    expect((call?.output as { undo?: unknown } | undefined)?.undo).toEqual({ tool: "set_book_settings", input: { id: bookId, title: "Moby-Dick" } });

    expect((await post("/assistant/undo", { toolCallId: call!.toolCallId })).statusCode).toBe(200);
    expect((await bookTitle(bookId))?.title).toBe("Moby-Dick");
    expect((toolParts((await loadMessages(id))[1])[0]?.output as { undone?: boolean } | undefined)?.undone).toBe(true);
    expect((await post("/assistant/undo", { toolCallId: call!.toolCallId })).statusCode).toBe(400);
  });

  it("holds a call that changes something until the person says Run, then goes on in the same answer", async () => {
    const { id, bookId, post } = await setup();
    resolveLlm.mockResolvedValue({ model: scriptedModel([{ tool: "set_book_settings", input: { id: bookId, voice: "kokoro:af_bella" } }, { text: "Voice changed." }]), def });
    expect((await post("/assistant", { text: "Use Bella" })).statusCode).toBe(200);
    // Nothing ran: the card is waiting
    expect((await bookTitle(bookId))?.voice).not.toBe("kokoro:af_bella");
    let [, answer] = await loadMessages(id);
    const [request] = toolParts(answer);
    expect(request?.state).toBe("approval-requested");
    expect(request?.approval?.id).toBeTruthy();

    expect((await post("/assistant", { trigger: "approval", approvalId: request!.approval!.id, approved: true })).statusCode).toBe(200);
    expect((await bookTitle(bookId))?.voice).toBe("kokoro:af_bella");
    const history = await loadMessages(id);
    // One answer, continued in place: the call, its result, then the words
    expect(history).toHaveLength(2);
    [, answer] = history;
    expect(toolParts(answer)[0]?.state).toBe("output-available");
    expect(answer?.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).toEqual(["Voice changed."]);
    expect(answer?.metadata?.status).toBe("complete");
  });

  it("answers every card of one turn in one request: the approved one runs, the cancelled one does not", async () => {
    const { id, bookId, post } = await setup();
    resolveLlm.mockResolvedValue({ model: scriptedModel([
      { calls: [{ tool: "set_book_settings", input: { id: bookId, voice: "kokoro:af_bella" } }, { tool: "set_book_settings", input: { id: bookId, speed: 1.5 } }] },
      { text: "Done what was allowed." },
    ]), def });
    expect((await post("/assistant", { text: "Bella, faster" })).statusCode).toBe(200);
    const [voiceCard, speedCard] = toolParts((await loadMessages(id))[1]);
    expect([voiceCard?.state, speedCard?.state]).toEqual(["approval-requested", "approval-requested"]);

    const approvals = [{ id: voiceCard!.approval!.id, approved: true }, { id: speedCard!.approval!.id, approved: false }];
    expect((await post("/assistant", { trigger: "approval", approvals })).statusCode).toBe(200);
    const book = (await getDb().select({ voice: books.voice, speed: books.speed }).from(books).where(eq(books.id, bookId)))[0];
    expect(book?.voice).toBe("kokoro:af_bella");
    expect(book?.speed).not.toBe(1.5);
    const [ran, refused] = toolParts((await loadMessages(id))[1]);
    expect(ran?.state).toBe("output-available");
    expect(refused?.state).toBe("output-denied");
  });

  it("a cancelled card runs nothing, and a card walked past is refused on the person's behalf", async () => {
    const { id, bookId, post } = await setup();
    resolveLlm.mockResolvedValue({ model: scriptedModel([
      { tool: "set_book_settings", input: { id: bookId, voice: "kokoro:af_bella" } },
      { text: "Left as it was." },
      { tool: "cancel_book", input: { id: bookId } },
      { text: "Something else." },
    ]), def });
    await post("/assistant", { text: "Use Bella" });
    const first = toolParts((await loadMessages(id))[1])[0]!;
    expect((await post("/assistant", { trigger: "approval", approvalId: first.approval!.id, approved: false })).statusCode).toBe(200);
    expect((await bookTitle(bookId))?.voice).not.toBe("kokoro:af_bella");
    expect(toolParts((await loadMessages(id))[1])[0]?.state).toBe("output-denied");

    // A second card, then a new question instead of an answer to it
    await post("/assistant", { text: "Stop it" });
    expect(toolParts((await loadMessages(id))[3])[0]?.state).toBe("approval-requested");
    await post("/assistant", { text: "Never mind, what else?" });
    const walkedPast = toolParts((await loadMessages(id))[3])[0];
    expect(walkedPast?.state).toBe("approval-responded");
    expect(walkedPast?.approval?.approved).toBe(false);
    expect((await loadMessages(id)).at(-1)?.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).toEqual(["Something else."]);
  });

  it("keeps an answer that carried no words and no call as failed, so it can be asked again", async () => {
    const { id, post } = await setup();
    const thinkingOnly = new MockLanguageModelV4({
      doStream: async () => ({ stream: streamOf([{ type: "stream-start", warnings: [] }, { type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "Hmm." }, { type: "reasoning-end", id: "r" }, finish("stop")]) } as never),
    });
    resolveLlm.mockResolvedValue({ model: thinkingOnly, def });
    expect((await post("/assistant", { text: "hello" })).statusCode).toBe(200);
    const [, answer] = await loadMessages(id);
    expect(answer?.metadata?.status).toBe("failed");
    expect(answer?.metadata?.error).toMatch(/answered with nothing/);
  });

  it("lets go of the run when the model cannot be resolved", async () => {
    const { id, post } = await setup();
    resolveLlm.mockRejectedValueOnce(new Error("provider is down"));
    expect((await post("/assistant", { text: "hello" })).statusCode).toBe(503);
    expect(isChatRunning(id)).toBe(false);
    expect(await loadMessages(id)).toEqual([]);
  });
});
