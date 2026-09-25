import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { streamText, stepCountIs, convertToModelMessages, toUIMessageStream } from "ai";
import { profileIdFromHeader } from "./trpc.ts";
import { contextExceeded, resolveLlm, modelKeySchema } from "./lib/llm.ts";
import { describeError } from "./lib/errors.ts";
import {
  appendQuestion,
  claimChatRun,
  denyPendingApprovals,
  getConversation,
  isChatRunning,
  loadMessages,
  messagesForModel,
  releaseChatRun,
  resolveScope,
  respondToApproval,
  retryQuestion,
  searchScopeOf,
  updateMessageParts,
  type StoredChatMessage,
  type ToolPartLike,
} from "./lib/chats.ts";
import { deliverAnswer } from "./lib/chat-run.ts";
import { assistantSystem, screenContext, screenSchema } from "./lib/assistant.ts";
import { assistantTools, isAssistantTool, needsApproval } from "./lib/assistant-tools.ts";
import { verifySources } from "./lib/citations.ts";
import { withReaderTargets } from "./lib/citation-targets.ts";
import { seedCatalog } from "./lib/chats.ts";
import { undoOf } from "./lib/assistant-tiers.ts";
import { estimateTokens } from "./lib/token-estimate.ts";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { books, chapters } from "./schema.ts";
import { claimStaged, isStagedRef, listStaged, stagedRef, touchStaged } from "./lib/staged-files.ts";

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  // "approval" answers a card: the call the model asked for is run (or refused) and the answer
  // goes on from there, in the same message
  trigger: z.enum(["submit", "regenerate", "approval"]).default("submit"),
  text: z.string().trim().max(8000).default(""),
  question: z.number().int().min(1).optional(),
  // The cards answered: one turn can hold several, and the SDK sends them together once every
  // card has its answer. The single pair is the older spelling of one.
  approvals: z.array(z.object({ id: z.string().min(1).max(200), approved: z.boolean() })).min(1).max(20).optional(),
  approvalId: z.string().min(1).max(200).optional(),
  approved: z.boolean().optional(),
  model: modelKeySchema.optional(),
  screen: screenSchema,
  // Files dropped on the panel and sent with this question, as staged:<id> references
  staged: z.array(z.string().refine(isStagedRef, "not a staged file")).max(50).default([]),
  // Text pinned in the panel to be read whole: the book, or chapters of it (the Ask AI hand-off)
  read: z.object({ bookId: z.string().uuid(), chapterIds: z.array(z.string().uuid()).min(1).max(500).optional() }).optional(),
});
type ReadRequest = NonNullable<z.infer<typeof bodySchema>["read"]>;

const undoSchema = z.object({
  conversationId: z.string().uuid(),
  toolCallId: z.string().min(1).max(200),
});

const MAX_STEPS = 6;
const TIMEOUT_MS = 180_000;
export const FINAL_STEP_MESSAGE =
  "You have used every look-up for this answer and no tool is available any more. Answer now from what you found, in the language the question was asked in. Do not write a tool call.";
const WALKED_PAST = "Not run — the conversation moved on";
const CANCELLED = "Cancelled by the person";

// The reference rides in the message the model reads; the panel hides it in the bubble the person
// sees. Without it the model had to match a filename to a list and reasoned in circles over which.
function describeAttachments(files: { id: string; filename: string; sizeBytes: number }[]): string {
  return files.map((f) => `${f.filename} (${(f.sizeBytes / 1_000_000).toFixed(1)} MB, ${stagedRef(f.id)})`).join("; ");
}

class Refusal extends Error {}
const refusal = (message: string) => new Refusal(message);

// The pinned text rides in the question the way dropped files do: named with the ids analyze_text
// takes, so the model copies rather than looks up, and titled from the library rather than the
// request. The panel hides the ids in the bubble.
export async function describeRead(read: ReadRequest): Promise<string> {
  const [book] = await db.select({ title: books.title }).from(books).where(eq(books.id, read.bookId));
  if (!book) throw refusal("That book is not in the library any more");
  if (!read.chapterIds) return `Read the whole text of "${book.title}" (bookId ${read.bookId}).`;
  const rows = await db.select({ id: chapters.id, title: chapters.title }).from(chapters).where(and(eq(chapters.bookId, read.bookId), inArray(chapters.id, read.chapterIds)));
  const titles = new Map(rows.map((r) => [r.id, r.title]));
  const named = read.chapterIds.flatMap((id) => (titles.has(id) ? [`"${titles.get(id)}" (chapter ${id})`] : []));
  if (named.length === 0) throw refusal("Those chapters are not in the book any more");
  return `Read ${named.length === 1 ? "this chapter" : "these chapters"} of "${book.title}": ${named.join("; ")}.`;
}

// The assistant panel's answers: the same stored conversations and server-owned runs as the
// library chat, with the MCP tool set in place of the search tools and the page's context in the
// system prompt. The request brings one question and where the person is; the transcript is the server's.
export function registerAssistantRoutes(fastify: FastifyInstance) {
  fastify.post("/assistant", async (request, reply) => {
    const body = bodySchema.parse(request.body);
    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);
    const conversation = await getConversation(profileId, body.conversationId);
    if (!conversation || conversation.kind !== "assistant") return reply.status(404).send({ error: "Conversation not found" });
    if (body.trigger === "submit" && !body.text) return reply.status(400).send({ error: "Empty question" });
    // Narrowed into locals: the schema cannot tie the two fields to the trigger
    const approvals = body.trigger !== "approval"
      ? []
      : body.approvals ?? (body.approvalId !== undefined && body.approved !== undefined ? [{ id: body.approvalId, approved: body.approved }] : []);
    if (body.trigger === "approval" && approvals.length === 0) return reply.status(400).send({ error: "An approval names the request and the answer" });

    let llm;
    try {
      llm = await resolveLlm(body.model);
    } catch (err) {
      return reply.status(503).send({ error: describeError(err) });
    }
    if (!llm.def.supportsTools) {
      return reply.status(400).send({ error: `${llm.def.label} cannot call tools, which the assistant needs — pick another model` });
    }

    const run = claimChatRun(conversation.id);
    if (!run) return reply.status(409).send({ error: "This conversation is already answering" });

    let toolSet;
    try {
      // The answer being continued, when a card was answered: the model goes on in that message
      let continueFrom: StoredChatMessage | undefined;
      if (approvals.length > 0) {
        let history = await loadMessages(conversation.id);
        for (const approval of approvals) {
          const responded = respondToApproval(history, approval.id, approval.approved, approval.approved ? undefined : CANCELLED);
          if (!responded) throw refusal("That card is no longer waiting — reload to see where the conversation stands");
          history = [...history.slice(0, -1), responded];
          continueFrom = responded;
        }
        if (continueFrom) await updateMessageParts(continueFrom.id, continueFrom.parts);
      } else {
        // A card the person walked past is answered no on their behalf before the next question
        const last = (await loadMessages(conversation.id)).at(-1);
        const denied = last?.role === "assistant" ? denyPendingApprovals(last, WALKED_PAST) : null;
        if (denied) await updateMessageParts(denied.id, denied.parts);
        if (body.trigger === "submit") {
          // The files ride in the question itself: a later turn, or a reload, reads them from the
          // transcript like any other words, and the model is handed the references in its context
          const attached = await claimStaged(body.staged, conversation.id, profileId);
          const lines = [body.text];
          if (attached.length > 0) lines.push(`Attached: ${describeAttachments(attached)}`);
          if (body.read) lines.push(await describeRead(body.read));
          await appendQuestion(conversation, lines.join("\n\n"), llm.def.key);
        } else {
          const outcome = await retryQuestion(conversation, { ordinal: body.question, text: body.text, model: llm.def.key });
          if (outcome === "nothing-to-ask") throw refusal("There is no question to ask again");
          if (outcome === "out-of-step") throw refusal("This conversation has moved on in another window — reload it to see where it stands");
        }
      }
      await touchStaged(conversation.id);
      const history = await loadMessages(conversation.id);
      const modelMessages = await convertToModelMessages(messagesForModel(history));
      const context = { ...(await screenContext(profileId, body.screen)), stagedFiles: await listStaged(conversation.id) };
      const system = assistantSystem(context);
      const tokens = estimateTokens(system) + estimateTokens(JSON.stringify(modelMessages));
      if (contextExceeded(llm.def, tokens)) throw refusal(`This conversation has outgrown ${llm.def.label} — start a new chat`);
      const catalog = seedCatalog(history);
      // What the search may see: the page, when the thread follows it, else what the thread chose
      const scope = searchScopeOf(profileId, await resolveScope(profileId, conversation.scope), body.screen.bookId);
      if (!scope) throw refusal("Everything this conversation searched has been removed from the library — start a new chat");
      toolSet = await assistantTools(profileId, { scope, catalog, llm });
      const { tools } = toolSet;

      await deliverAnswer({
        request,
        reply,
        conversationId: conversation.id,
        run,
        model: llm.def,
        failedText: "The assistant failed",
        continueFrom,
        execute: async (writer, metadata, fail, streamOptions) => {
          const result = streamText({
            model: llm.model,
            system,
            messages: modelMessages,
            tools,
            // Per call: a rename runs, a text replacement or an upload waits for the card's Run
            toolApproval: needsApproval,
            stopWhen: stepCountIs(MAX_STEPS),
            prepareStep: ({ stepNumber, messages }) =>
              stepNumber >= MAX_STEPS - 1
                ? { activeTools: [], messages: [...messages, { role: "user", content: FINAL_STEP_MESSAGE }] }
                : undefined,
            abortSignal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(TIMEOUT_MS)]),
            // The library chat's budget: a reasoning model spends part of it thinking before a word lands
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
          if (sources.length > 0) writer.write({ type: "data-sources", data: await withReaderTargets(sources).catch(() => sources) });
        },
        // An answer cut short keeps the citations it had already made, as the library chat does
        partialExtras: async (latest) => {
          const partial = latest.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
          const sources = verifySources(partial, catalog);
          return sources.length > 0 ? [{ type: "data-sources", data: await withReaderTargets(sources).catch(() => sources) }] : [];
        },
      });
    } catch (err) {
      // deliverAnswer releases the run itself once it has started; anything thrown before it
      // would otherwise leave the conversation answering 409 until a restart
      if (!reply.raw.headersSent) releaseChatRun(conversation.id, run);
      if (err instanceof Refusal) return reply.status(400).send({ error: err.message });
      throw err;
    } finally {
      await toolSet?.close();
    }
  });

  // The Done card's Undo: the reversing call a quick tool answered with, run as the server, no
  // model turn. The part remembers it was undone, so the card says so after a reload too.
  fastify.post("/assistant/undo", async (request, reply) => {
    const body = undoSchema.parse(request.body);
    const profileId = profileIdFromHeader(request.headers["x-profile-id"]);
    const conversation = await getConversation(profileId, body.conversationId);
    if (!conversation || conversation.kind !== "assistant") return reply.status(404).send({ error: "Conversation not found" });
    if (isChatRunning(conversation.id)) return reply.status(409).send({ error: "This conversation is answering — wait for it to finish" });

    const history = await loadMessages(conversation.id);
    const message = history.at(-1);
    if (!message || message.role !== "assistant") return reply.status(400).send({ error: "Nothing to undo" });
    const part = message.parts.find((p) => (p as ToolPartLike).toolCallId === body.toolCallId) as (ToolPartLike & { output?: unknown }) | undefined;
    const undo = part ? undoOf(part.output) : null;
    if (!part || !undo) return reply.status(400).send({ error: "Nothing to undo" });
    if ((part.output as { undone?: boolean }).undone) return reply.status(400).send({ error: "Already undone" });
    if (!isAssistantTool(undo.tool)) return reply.status(400).send({ error: "Nothing to undo" });

    const toolSet = await assistantTools(profileId);
    try {
      await toolSet.run(undo.tool, undo.input);
    } catch (err) {
      return reply.status(400).send({ error: describeError(err) });
    } finally {
      await toolSet.close();
    }
    const parts = message.parts.map((p) => (p === part ? { ...p, output: { ...(part.output as Record<string, unknown>), undone: true } } : p));
    await updateMessageParts(message.id, parts);
    return reply.send({ undone: true });
  });
}
