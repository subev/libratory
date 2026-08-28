import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { db } from "../db.ts";
import { books, folders, DEFAULT_PROFILE_ID } from "../schema.ts";
import { eq, and, asc, inArray } from "drizzle-orm";
import { folderSubtreeIds, folderAncestors } from "../lib/folders.ts";
import { deleteBook } from "../lib/delete-book.ts";

// Subtree/ancestor walks stay unscoped: a folder tree never crosses profiles because
// create/move validate the parent against the caller's profile.
async function ownedFolder(id: string, profileId: string) {
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.profileId, profileId)));
  return folder;
}

export const foldersRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
    return db
      .select({ id: folders.id, name: folders.name, parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.profileId, profileId))
      .orderBy(asc(folders.name));
  }),

  create: publicProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(200),
      parentId: z.string().uuid().nullable().default(null),
    }))
    .mutation(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      if (input.parentId) {
        const parent = await ownedFolder(input.parentId, profileId);
        if (!parent) throw new Error("Parent folder not found");
      }
      const [folder] = await db
        .insert(folders)
        .values({ name: input.name, parentId: input.parentId, profileId })
        .returning();
      if (!folder) throw new Error("Failed to create the folder");
      return folder;
    }),

  rename: publicProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(200) }))
    .mutation(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      await db
        .update(folders)
        .set({ name: input.name, updatedAt: new Date() })
        .where(and(eq(folders.id, input.id), eq(folders.profileId, profileId)));
      return { success: true };
    }),

  move: publicProcedure
    .input(z.object({ id: z.string().uuid(), parentId: z.string().uuid().nullable() }))
    .mutation(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      const folder = await ownedFolder(input.id, profileId);
      if (!folder) throw new Error("Folder not found");
      if (input.parentId) {
        const subtree = await folderSubtreeIds(input.id);
        if (subtree.includes(input.parentId)) {
          throw new Error("Cannot move a folder into itself or its own subtree");
        }
        const target = await ownedFolder(input.parentId, profileId);
        if (!target) throw new Error("Target folder not found");
      }
      await db
        .update(folders)
        .set({ parentId: input.parentId, updatedAt: new Date() })
        .where(eq(folders.id, input.id));
      return { success: true };
    }),

  path: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      const folder = await ownedFolder(input.id, profileId);
      if (!folder) throw new Error("Folder not found");
      return folderAncestors(input.id);
    }),

  deleteStats: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      const folder = await ownedFolder(input.id, profileId);
      if (!folder) throw new Error("Folder not found");
      const subtree = await folderSubtreeIds(input.id);
      const bookRows = await db
        .select({ id: books.id })
        .from(books)
        .where(inArray(books.folderId, subtree));
      return { folderCount: subtree.length, bookCount: bookRows.length };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      const folder = await ownedFolder(input.id, profileId);
      if (!folder) throw new Error("Folder not found");
      const subtree = await folderSubtreeIds(input.id);
      const bookRows = await db
        .select({ id: books.id })
        .from(books)
        .where(inArray(books.folderId, subtree));
      for (const { id } of bookRows) {
        await deleteBook(id);
      }
      await db.delete(folders).where(eq(folders.id, input.id));
      return { deletedBooks: bookRows.length, deletedFolders: subtree.length };
    }),
});
