import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { db } from "../db.ts";
import { profiles, folders, books, DEFAULT_PROFILE_ID } from "../schema.ts";
import { eq, asc, count } from "drizzle-orm";
import { bookTotalSizeCached } from "../lib/disk-usage.ts";

export const profilesRouter = router({
  list: publicProcedure.query(async () => {
    const [rows, bookCounts, folderCounts] = await Promise.all([
      db.select({ id: profiles.id, name: profiles.name }).from(profiles).orderBy(asc(profiles.createdAt)),
      db.select({ profileId: books.profileId, n: count() }).from(books).groupBy(books.profileId),
      db.select({ profileId: folders.profileId, n: count() }).from(folders).groupBy(folders.profileId),
    ]);
    const bookCount = new Map(bookCounts.map((r) => [r.profileId, r.n]));
    const folderCount = new Map(folderCounts.map((r) => [r.profileId, r.n]));
    return rows.map((r) => ({
      ...r,
      isDefault: r.id === DEFAULT_PROFILE_ID,
      books: bookCount.get(r.id) ?? 0,
      folders: folderCount.get(r.id) ?? 0,
    }));
  }),

  // Separate from list because it walks the library on disk; the switcher only asks once it opens.
  usage: publicProcedure.query(async () => {
    const rows = await db.select({ id: books.id, profileId: books.profileId }).from(books);
    const sizes = await Promise.all(rows.map((book) => bookTotalSizeCached(book.id)));
    const bytes: Record<string, number> = {};
    rows.forEach((book, i) => {
      bytes[book.profileId] = (bytes[book.profileId] ?? 0) + sizes[i]!;
    });
    return bytes;
  }),

  create: publicProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ input }) => {
      const [profile] = await db.insert(profiles).values({ name: input.name }).returning();
      if (!profile) throw new Error("Failed to create the profile");
      return profile;
    }),

  rename: publicProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ input }) => {
      const [profile] = await db
        .update(profiles)
        .set({ name: input.name })
        .where(eq(profiles.id, input.id))
        .returning();
      if (!profile) throw new Error("Profile not found");
      return profile;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      if (input.id === DEFAULT_PROFILE_ID) throw new Error("Cannot delete the default profile");
      const [book] = await db.select({ id: books.id }).from(books).where(eq(books.profileId, input.id)).limit(1);
      const [folder] = await db.select({ id: folders.id }).from(folders).where(eq(folders.profileId, input.id)).limit(1);
      if (book || folder) throw new Error("Profile still has books or folders — delete or move them first");
      const deleted = await db.delete(profiles).where(eq(profiles.id, input.id)).returning();
      if (deleted.length === 0) throw new Error("Profile not found");
      return { success: true };
    }),
});
