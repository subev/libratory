import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { router, publicProcedure } from "../trpc.ts";
import { db } from "../db.ts";
import { books, chatConversations, DEFAULT_PROFILE_ID } from "../schema.ts";
import { modelKeySchema } from "../lib/llm.ts";
import {
  createConversation,
  deleteConversation,
  getConversation,
  isChatRunning,
  liveAnswer,
  listConversations,
  loadMessages,
  removedBookIds,
  resolveScope,
  scopeFromInput,
  stopChatRun,
  type WireChatMessage,
} from "../lib/chats.ts";

const scopeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library") }),
  z.object({ kind: z.literal("folder"), folderId: z.string().uuid() }),
  z.object({ kind: z.literal("books"), bookIds: z.array(z.string().uuid()).min(1).max(200) }),
]);

export const chatsRouter = router({
  list: publicProcedure.query(({ ctx }) => listConversations(ctx.profileId ?? DEFAULT_PROFILE_ID)),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      const conversation = await getConversation(profileId, input.id);
      if (!conversation) return null;
      // Read before the table: a run that ends in between is then in the table, never in neither
      const live = liveAnswer(conversation.id);
      const running = isChatRunning(conversation.id);
      const stored = await loadMessages(conversation.id);
      const scope = await resolveScope(profileId, conversation.scope);
      return {
        id: conversation.id,
        title: conversation.title,
        model: conversation.model,
        scope,
        removedBookIds: await removedBookIds(profileId, scope, stored),
        messages: [...stored, ...(running && live ? [live] : [])].flatMap((message): WireChatMessage[] =>
          message.role === "system" || !message.metadata ? [] : [{ id: message.id, role: message.role, parts: message.parts, metadata: message.metadata }]),
        running,
      };
    }),

  // Every book of the profile, for choosing what a new chat searches
  bookOptions: publicProcedure.query(({ ctx }) =>
    db
      .select({ id: books.id, title: books.title, author: books.author })
      .from(books)
      .where(eq(books.profileId, ctx.profileId ?? DEFAULT_PROFILE_ID))
      .orderBy(asc(books.title)),
  ),

  create: publicProcedure
    .input(z.object({ scope: scopeInput, model: modelKeySchema.optional() }))
    .mutation(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      const scope = await scopeFromInput(profileId, input.scope);
      const id = await createConversation(profileId, scope, input.model ?? null);
      return { id, scope: await resolveScope(profileId, scope) };
    }),

  rename: publicProcedure
    .input(z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(200) }))
    .mutation(async ({ input, ctx }) => {
      await db
        .update(chatConversations)
        .set({ title: input.title })
        .where(and(eq(chatConversations.id, input.id), eq(chatConversations.profileId, ctx.profileId ?? DEFAULT_PROFILE_ID)));
      return { success: true };
    }),

  // The only thing that ends an answer early: closing the page does not. Returns once the run has
  // let go, so "Ask again" straight after is never refused as "already answering".
  stop: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const conversation = await getConversation(ctx.profileId ?? DEFAULT_PROFILE_ID, input.id);
      if (!conversation) throw new Error("Conversation not found");
      return { stopped: await stopChatRun(conversation.id) };
    }),

  // Removes the conversation only — the books it searched and notes saved from it are untouched
  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const deleted = await deleteConversation(ctx.profileId ?? DEFAULT_PROFILE_ID, input.id);
      if (!deleted) throw new Error("Conversation not found");
      return { success: true };
    }),
});
