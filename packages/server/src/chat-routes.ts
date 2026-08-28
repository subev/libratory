import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { profileIdFromHeader } from "./trpc.ts";
import { resolveLlm, modelKeySchema } from "./lib/llm.ts";
import { describeError } from "./lib/errors.ts";
import { buildChatTools, CitationCatalog, LIBRARY_CHAT_SYSTEM, type CitationSource } from "./lib/chat-tools.ts";
import { verifySources } from "./lib/citations.ts";
import { buildAskContext, type AskScope } from "./lib/ask-ai.ts";
import { estimateTokens } from "./lib/token-estimate.ts";
import { saveNote } from "./lib/notes.ts";

const bodySchema = z.object({
  messages: z.array(z.any()).min(1).max(100),
  scope: z.object({ folderId: z.string().uuid().optional(), bookId: z.string().uuid().optional() }).default({}),
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

const MAX_STEPS = 8;
const CHAT_TIMEOUT_MS = 180_000;

function seedCatalogFromHistory(catalog: CitationCatalog, messages: UIMessage[]) {
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === "data-sources" && Array.isArray((part as { data?: unknown }).data)) {
        catalog.seed((part as { data: CitationSource[] }).data);
      }
    }
  }
}

export function registerChatRoutes(fastify: FastifyInstance) {
  fastify.post("/chat", async (request, reply) => {
    const body = bodySchema.parse(request.body);
    let llm;
    try {
      llm = await resolveLlm(body.model);
    } catch (err) {
      return reply.status(503).send({ error: describeError(err) });
    }
    if (!llm.def.supportsTools) {
      return reply.status(400).send({ error: `${llm.def.label} does not support the tools the library chat needs — pick another model` });
    }
    const messages = body.messages as UIMessage[];
    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);

    const catalog = new CitationCatalog();
    seedCatalogFromHistory(catalog, messages);
    const tools = buildChatTools({ profileId, folderId: body.scope.folderId, bookId: body.scope.bookId, catalog });

    const stream = createUIMessageStream({
      onError: (err) => (err instanceof Error ? err.message : "Chat failed"),
      execute: async ({ writer }) => {
        const result = streamText({
          model: llm.model,
          system: LIBRARY_CHAT_SYSTEM,
          messages: await convertToModelMessages(messages),
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          // Last step must produce text — otherwise a search-happy model burns
          // all steps on tools and the stream ends with no answer at all
          prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: "none" } : undefined),
          abortSignal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
          maxOutputTokens: 4096,
        });
        writer.merge(toUIMessageStream({ stream: result.stream, tools }));
        const text = await result.text;
        writer.write({ type: "data-sources", data: verifySources(text, catalog) });
      },
    });

    reply.hijack();
    await pipeUIMessageStreamToResponse({ response: reply.raw, stream });
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
    if (tokens > llm.def.contextTokens) {
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
