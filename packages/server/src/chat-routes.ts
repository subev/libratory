import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  readUIMessageStream,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { profileIdFromHeader } from "./trpc.ts";
import { contextExceeded, resolveLlm, modelKeySchema } from "./lib/llm.ts";
import { describeError } from "./lib/errors.ts";
import { buildChatTools, CitationCatalog, libraryChatSystem, scopeLanguages, type ChatSearchScope } from "./lib/chat-tools.ts";
import {
  appendQuestion,
  claimChatRun,
  getConversation,
  loadMessages,
  messagesForModel,
  releaseChatRun,
  retryQuestion,
  resolveScope,
  saveAnswer,
  searchScopeOf,
  sourcesOf,
  type ChatMessageMetadata,
  type StoredChatMessage,
} from "./lib/chats.ts";
import { withReaderTargets } from "./lib/citation-targets.ts";
import { verifySources } from "./lib/citations.ts";
import { buildAskContext, type AskScope } from "./lib/ask-ai.ts";
import { estimateTokens } from "./lib/token-estimate.ts";
import { saveNote } from "./lib/notes.ts";

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  // "regenerate" answers the last question again; it carries no text of its own
  trigger: z.enum(["submit", "regenerate"]).default("submit"),
  text: z.string().trim().max(8000).default(""),
  // Which question a regenerate means: the page's count of questions up to and including it
  question: z.number().int().min(1).optional(),
  model: modelKeySchema.optional(),
});

const askSchema = z.object({
  messages: z.array(z.any()).min(1).max(10),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("book-raw"), bookId: z.string().uuid() }),
    z.object({ kind: z.literal("chapters"), chapterIds: z.array(z.string().uuid()).min(1).max(500) }),
  ]),
  model: modelKeySchema.optional(),
});

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    return (message.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  return "";
}

// A live answer has no row yet; the page only needs a stable key for it
const LIVE_MESSAGE_ID = "live";

const MAX_STEPS = 8;
const CHAT_TIMEOUT_MS = 180_000;

// Saves the question (or clears the way to ask it again) and gathers what the answer needs. A
// refusal leaves the question saved and unanswered — nothing is dropped or summarised to make room.
async function prepareAnswer(opts: {
  conversation: { id: string; title: string };
  trigger: "submit" | "regenerate";
  text: string;
  question: number | undefined;
  llm: Awaited<ReturnType<typeof resolveLlm>>;
  scope: ChatSearchScope;
}) {
  const { conversation, llm, scope } = opts;
  if (opts.trigger === "submit") await appendQuestion(conversation, opts.text, llm.def.key);
  else {
    const outcome = await retryQuestion(conversation, { ordinal: opts.question, text: opts.text, model: llm.def.key });
    if (outcome === "nothing-to-ask") return { refusal: "There is no question to ask again" };
    if (outcome === "out-of-step") return { refusal: "This conversation has moved on in another window — reload it to see where it stands" };
  }
  const history = await loadMessages(conversation.id);

  const modelMessages = await convertToModelMessages(messagesForModel(history));
  const tokens = estimateTokens(JSON.stringify(modelMessages));
  if (contextExceeded(llm.def, tokens)) {
    return { refusal: `This conversation (~${Math.round(tokens / 1000)}k tokens) has outgrown ${llm.def.label} — pick a model with more room, or start a new chat` };
  }

  const catalog = new CitationCatalog();
  for (const message of history) catalog.seed(sourcesOf(message.parts));
  return { modelMessages, catalog, tools: buildChatTools({ ...scope, catalog }), system: libraryChatSystem(await scopeLanguages(scope)) };
}

export function registerChatRoutes(fastify: FastifyInstance) {
  // The transcript is the server's: the request names a conversation and brings one question,
  // never a history to be believed
  fastify.post("/chat", async (request, reply) => {
    const body = bodySchema.parse(request.body);
    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);
    const conversation = await getConversation(profileId, body.conversationId);
    if (!conversation) return reply.status(404).send({ error: "Conversation not found" });
    if (body.trigger === "submit" && !body.text) return reply.status(400).send({ error: "Empty question" });

    let llm;
    try {
      llm = await resolveLlm(body.model);
    } catch (err) {
      return reply.status(503).send({ error: describeError(err) });
    }
    if (!llm.def.supportsTools) {
      return reply.status(400).send({ error: `${llm.def.label} does not support the tools the library chat needs — pick another model` });
    }

    const scope = searchScopeOf(profileId, await resolveScope(profileId, conversation.scope));
    if (!scope) {
      return reply.status(409).send({ error: "Everything this conversation searched has been removed from the library — start a new chat" });
    }

    const run = claimChatRun(conversation.id);
    if (!run) return reply.status(409).send({ error: "This conversation is already answering" });

    // Everything between claiming the run and streaming can throw, and a run that is never
    // released answers 409 to every later question until the server restarts
    let prepared;
    try {
      prepared = await prepareAnswer({ conversation, trigger: body.trigger, text: body.text, question: body.question, llm, scope });
    } catch (err) {
      releaseChatRun(conversation.id, run);
      throw err;
    }
    if ("refusal" in prepared) {
      releaseChatRun(conversation.id, run);
      return reply.status(400).send({ error: prepared.refusal });
    }
    const { modelMessages, catalog, tools, system } = prepared;

    let completed = false;
    let failure: string | null = null;
    const fail = (err: unknown) => {
      failure = err instanceof Error ? err.message : "Chat failed";
      return failure;
    };
    const metadata: ChatMessageMetadata = {
      status: "complete",
      error: null,
      modelKey: llm.def.key,
      modelLabel: llm.def.label,
      createdAt: new Date().toISOString(),
    };

    const stream = createUIMessageStream<StoredChatMessage>({
      onError: fail,
      execute: async ({ writer }) => {
        const result = streamText({
          model: llm.model,
          system,
          messages: modelMessages,
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          // Last step must produce text — otherwise a search-happy model burns
          // all steps on tools and the stream ends with no answer at all
          prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: "none" } : undefined),
          abortSignal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]),
          maxOutputTokens: 4096,
        });
        writer.merge(toUIMessageStream<typeof tools, StoredChatMessage>({
          stream: result.stream,
          tools,
          onError: fail,
          messageMetadata: ({ part }) => (part.type === "start" ? metadata : undefined),
        }));
        const text = await result.text;
        if (run.controller.signal.aborted) return;
        const sources = verifySources(text, catalog);
        // The reader link is a convenience on top of the citation; failing to place one costs the link only
        writer.write({ type: "data-sources", data: await withReaderTargets(sources).catch(() => sources) });
        completed = true;
      },
    });

    // Two readers of one stream: the browser, and the copy that is kept. The run does not depend
    // on the first — a closed tab stops the delivery, not the answer, which is finished and kept
    // for whoever opens the conversation next.
    const [toClient, toStore] = stream.tee();
    const stored = (async () => {
      let latest: StoredChatMessage | undefined;
      try {
        for await (const message of readUIMessageStream<StoredChatMessage>({ stream: toStore, onError: fail })) {
          latest = message;
          run.latest = { ...message, id: LIVE_MESSAGE_ID, metadata: { ...metadata, status: "streaming" } };
        }
      } catch (err) {
        fail(err);
      }
      const status = completed ? "complete" : run.controller.signal.aborted ? "stopped" : "failed";
      let parts: unknown[] = latest?.parts ?? [];
      // A finished answer carries its sources in the stream. One that was cut short never got
      // that far, and without them every [c_N] it had already written rendered as nothing —
      // the words stayed, the links were gone for good. How it ended is left as it was.
      if (!completed && latest) {
        const partial = latest.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
        const sources = verifySources(partial, catalog);
        if (sources.length > 0) parts = [...parts, { type: "data-sources", data: await withReaderTargets(sources).catch(() => sources) }];
      }
      await saveAnswer({
        conversationId: conversation.id,
        parts,
        status,
        error: status === "failed" ? (failure ?? "The answer ended before it was finished") : null,
        model: llm.def.key,
        modelLabel: llm.def.label,
      });
    })();

    reply.hijack();
    // Not awaited: once the browser has gone, writing to its closed response never settles. The
    // kept copy always ends, so the run is released on that.
    void pipeUIMessageStreamToResponse({ response: reply.raw, stream: toClient }).catch((err: unknown) => {
      request.log.debug({ err }, "chat answer was not delivered");
    });
    try {
      await stored;
    } catch (err) {
      request.log.warn({ err }, "chat answer could not be kept");
    } finally {
      releaseChatRun(conversation.id, run);
    }
  });

  // One-shot Ask AI with the whole scope stuffed in context (no tools/retrieval);
  // streams the answer and auto-saves it as a note like the legacy sync mutations
  fastify.post("/chat/ask", async (request, reply) => {
    const body = askSchema.parse(request.body);
    let llm;
    try {
      llm = await resolveLlm(body.model);
    } catch (err) {
      return reply.status(503).send({ error: describeError(err) });
    }
    const prompt = lastUserText(body.messages as UIMessage[]).slice(0, 4000);
    if (!prompt) return reply.status(400).send({ error: "Empty prompt" });

    let context;
    try {
      context = await buildAskContext(body.scope as AskScope);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : "Failed to load text" });
    }

    const tokens = estimateTokens(context.corpus) + estimateTokens(prompt);
    if (contextExceeded(llm.def, tokens)) {
      return reply.status(400).send({
        error: `Raw text (~${Math.round(tokens / 1000)}k tokens) exceeds the model's context — extract chapters and ask per-chapter instead`,
      });
    }

    const stream = createUIMessageStream({
      onError: (err) => (err instanceof Error ? err.message : "Ask AI failed"),
      execute: async ({ writer }) => {
        const result = streamText({
          model: llm.model,
          system: context.system,
          prompt: `${prompt}\n\n---\n${context.corpus}`,
          ...(llm.def.supportsTemperature ? { temperature: 0.7 } : {}),
          abortSignal: AbortSignal.timeout(600_000),
        });
        writer.merge(toUIMessageStream({ stream: result.stream }));
        const text = await result.text;
        if (text.trim()) {
          const noteId = await saveNote({
            bookId: context.bookId,
            prompt,
            model: llm.def.key,
            result: text,
            scope: context.noteScope,
          });
          writer.write({ type: "data-note", data: { noteId } });
        }
      },
    });

    reply.hijack();
    await pipeUIMessageStreamToResponse({ response: reply.raw, stream });
  });
}
