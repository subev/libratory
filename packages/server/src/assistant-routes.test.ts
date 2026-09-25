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

import { eq } from "drizzle-orm";
import { registerAssistantRoutes } from "./assistant-routes.ts";
import { registerChatRoutes } from "./chat-routes.ts";
import { createConversation, isChatRunning, loadMessages, type ToolPartLike } from "./lib/chats.ts";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = (unified: "stop" | "tool-calls") => ({ type: "finish" as const, finishReason: { unified, raw: unified }, usage });
const streamOf = (parts: unknown[]) =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

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

async function setup(kind: "assistant" | "library" = "assistant") {
  const bookId = crypto.randomUUID();
  await getDb().insert(books).values({ id: bookId, title: "Moby-Dick", filename: "m.pdf", pdfPath: "/tmp/m.pdf" });
  const id = await createConversation(DEFAULT_PROFILE_ID, { kind: "library" }, null, kind);
  const app = Fastify();
  registerAssistantRoutes(app);
  registerChatRoutes(app);
  const post = async (url: "/assistant" | "/chat" | "/assistant/undo", body: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url, payload: { conversationId: id, screen: { route: "/" }, ...body } });
    // Longer than the default second: under the whole suite the MCP hand-off and the model take their time
    await vi.waitFor(() => expect(isChatRunning(id)).toBe(false), { timeout: 10_000 });
    return response;
  };
  return { id, bookId, post };
}

const bookTitle = async (bookId: string) => (await getDb().select({ title: books.title, voice: books.voice }).from(books).where(eq(books.id, bookId)))[0];

describe("POST /assistant", () => {
  beforeEach(async () => {
    await resetDb(getDb());
    resolveLlm.mockReset();
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

  it("keeps the panel's threads and the library chat's apart", async () => {
    const { post } = await setup("library");
    resolveLlm.mockResolvedValue({ model: lookingModel(() => "x"), def });
    expect((await post("/assistant", { text: "hello" })).statusCode).toBe(404);

    const assistant = await setup("assistant");
    expect((await assistant.post("/chat", { text: "hello" })).statusCode).toBe(404);
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
