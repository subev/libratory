import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.ts";
import { extractionPresets } from "../schema.ts";
import { publicProcedure, router } from "../trpc.ts";
import { EXTRACTION_PRESETS, extractionSettingsSchema } from "../lib/extraction-presets.ts";

export const extractionPresetsRouter = router({
  list: publicProcedure.query(async () => [
    ...EXTRACTION_PRESETS,
    ...(await db.select().from(extractionPresets).orderBy(extractionPresets.name)).map((p) => ({ ...p, builtIn: false })),
  ]),
  save: publicProcedure.input(z.object({ name: z.string().trim().min(1).max(100), settings: extractionSettingsSchema }))
    .mutation(async ({ input }) => {
      const [preset] = await db.insert(extractionPresets).values(input).returning();
      return preset;
    }),
  remove: publicProcedure.input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => { await db.delete(extractionPresets).where(eq(extractionPresets.id, input.id)); }),
});
