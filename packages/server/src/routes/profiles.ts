import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { db } from "../db.ts";
import { profiles, folders, books, DEFAULT_PROFILE_ID } from "../schema.ts";
import { eq, asc } from "drizzle-orm";

export const profilesRouter = router({
  list: publicProcedure.query(async () => {
    const rows = await db
      .select({ id: profiles.id, name: profiles.name })
      .from(profiles)
      .orderBy(asc(profiles.createdAt));
    return rows.map((r) => ({ ...r, isDefault: r.id === DEFAULT_PROFILE_ID }));
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
