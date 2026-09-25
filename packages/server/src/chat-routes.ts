import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  toUIMessageStream,
} from "ai";
import { deliverAnswer } from "./lib/chat-run.ts";
import { profileIdFromHeader } from "./trpc.ts";
import { contextExceeded, resolveLlm, modelKeySchema } from "./lib/llm.ts";
import { describeError } from "./lib/errors.ts";
import { buildChatTools, libraryChatSystem, scopeLanguages, type ChatSearchScope } from "./lib/chat-tools.ts";
import {
  appendQuestion,
  claimChatRun,
  getConversation,
  loadMessages,
  messagesForModel,
  releaseChatRun,
  retryQuestion,
  resolveScope,
  searchScopeOf,
  seedCatalog,
  type StoredChatMessage,
} from "./lib/chats.ts";
import { withReaderTargets } from "./lib/citation-targets.ts";
import { verifySources } from "./lib/citations.ts";
import { estimateTokens } from "./lib/token-estimate.ts";

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  // "regenerate" answers the last question again; it carries no text of its own
  trigger: z.enum(["submit", "regenerate"]).default("submit"),
  text: z.string().trim().max(8000).default(""),
  // Which question a regenerate means: the page's count of questions up to and including it
  question: z.number().int().min(1).optional(),
  model: modelKeySchema.optional(),
});

const MAX_STEPS = 8;
// What the model is told on the final step, in place of its tools. DeepSeek answers
// `tool_choice: "none"` by writing the calls it still wants as raw DSML markup — the
// tools have to be gone from the request, and the model told why.
export const FINAL_STEP_MESSAGE =
  "You have used every search round for this answer and no tool is available any more. Answer now, in the language the question was asked in, from the passages already retrieved, citing their ids — or say plainly that the library does not seem to cover it. Do not write a tool call.";
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

  const catalog = seedCatalog(history);
  return { modelMessages, catalog, tools: buildChatTools({ ...scope, catalog }), system: libraryChatSystem(await scopeLanguages(scope)) };
}

export function registerChatRoutes(fastify: FastifyInstance) {
  // The transcript is the server's: the request names a conversation and brings one question,
  // never a history to be believed
  fastify.post("/chat", async (request, reply) => {
    const body = bodySchema.parse(request.body);
    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);
    const conversation = await getConversation(profileId, body.conversationId);
    if (!conversation || conversation.kind !== "library") return reply.status(404).send({ error: "Conversation not found" });
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

    await deliverAnswer({
      request,
      reply,
      conversationId: conversation.id,
      run,
      model: llm.def,
      failedText: "Chat failed",
      execute: async (writer, metadata, fail, streamOptions) => {
        const result = streamText({
          model: llm.model,
          system,
          messages: modelMessages,
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          // Last step must produce text — otherwise a search-happy model burns all steps on
          // tools and the stream ends with no answer at all. The tools are removed rather than
          // declined with toolChoice "none": DeepSeek honoured that by emitting the calls as text.
          prepareStep: ({ stepNumber, messages }) =>
            stepNumber >= MAX_STEPS - 1
              ? { activeTools: [], messages: [...messages, { role: "user", content: FINAL_STEP_MESSAGE }] }
              : undefined,
          abortSignal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]),
          maxOutputTokens: 4096,
        });
        writer.merge(toUIMessageStream<typeof tools, StoredChatMessage>({
          stream: result.stream,
          tools,
          onError: fail,
          ...streamOptions,
          messageMetadata: ({ part }) => (part.type === "start" ? metadata : undefined),
        }));
        const text = await result.text;
        if (run.controller.signal.aborted) return;
        const sources = verifySources(text, catalog);
        // The reader link is a convenience on top of the citation; failing to place one costs the link only
        writer.write({ type: "data-sources", data: await withReaderTargets(sources).catch(() => sources) });
      },
      // A finished answer carries its sources in the stream. One that was cut short never got
      // that far, and without them every [c_N] it had already written rendered as nothing —
      // the words stayed, the links were gone for good. How it ended is left as it was.
      partialExtras: async (latest) => {
        const partial = latest.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
        const sources = verifySources(partial, catalog);
        return sources.length > 0 ? [{ type: "data-sources", data: await withReaderTargets(sources).catch(() => sources) }] : [];
      },
    });
  });
}
