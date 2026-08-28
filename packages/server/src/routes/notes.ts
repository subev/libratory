import { z } from "zod";
import { modelKeySchema } from "../lib/llm.ts";
import { router, publicProcedure } from "../trpc.ts";
import { db } from "../db.ts";
import { books, chapters, notes, DEFAULT_PROFILE_ID } from "../schema.ts";
import { and, eq, desc, isNull, max } from "drizzle-orm";
import { appendLog } from "../lib/log.ts";
import { queueIndexBook } from "../lib/search-index.ts";
import { saveNote } from "../lib/notes.ts";

export const notesRouter = router({
  list: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .query(async ({ input }) => {
      return db.select().from(notes).where(eq(notes.bookId, input.bookId)).orderBy(desc(notes.createdAt));
    }),

  listLibrary: publicProcedure.query(async ({ ctx }) => {
    return db
      .select()
      .from(notes)
      .where(and(isNull(notes.bookId), eq(notes.profileId, ctx.profileId ?? DEFAULT_PROFILE_ID)))
      .orderBy(desc(notes.createdAt));
  }),

  saveLibraryAnswer: publicProcedure
    .input(z.object({
      question: z.string().min(1).max(4000),
      markdown: z.string().min(1),
      model: modelKeySchema.default("flash"),
      folderId: z.string().uuid().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const noteId = await saveNote({
        bookId: null,
        profileId: ctx.profileId ?? DEFAULT_PROFILE_ID,
        prompt: input.question,
        model: input.model,
        result: input.markdown,
        scope: { kind: "library", folderId: input.folderId, question: input.question },
      });
      return { noteId };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await db.delete(notes).where(eq(notes.id, input.id));
      return { success: true };
    }),

  toChapter: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const [note] = await db.select().from(notes).where(eq(notes.id, input.id));
      if (!note) throw new Error("Note not found");
      const bookId = note.bookId;
      if (!bookId) throw new Error("Library-wide notes are not attached to a book");

      const [tail] = await db
        .select({ maxIndex: max(chapters.index) })
        .from(chapters)
        .where(eq(chapters.bookId, bookId));
      const index = tail?.maxIndex != null ? tail.maxIndex + 1 : 0;
      const title = note.prompt.length > 100 ? `${note.prompt.slice(0, 100).trimEnd()}…` : note.prompt;

      const [chapter] = await db
        .insert(chapters)
        .values({
          bookId,
          index,
          title,
          rawText: note.result,
          source: { kind: "note", noteId: note.id },
          status: "suspended",
        })
        .returning({ id: chapters.id });

      if (!chapter) throw new Error("Failed to create the chapter");
      await db.update(books).set({ totalChapters: index + 1, updatedAt: new Date() }).where(eq(books.id, bookId));
      await appendLog(bookId, `Added note "${title}" as chapter ${index + 1}`);
      await queueIndexBook(bookId);
      return { chapterId: chapter.id, index };
    }),
});
