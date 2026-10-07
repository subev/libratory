import { stat } from "node:fs/promises";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db.ts";
import { chapters, chapterVariants } from "../schema.ts";

// Audio made before `synthesizedWith.at` was recorded gets its file's modified time — the encode
// wrote it (an MP3 later converted to M4A is dated by the conversion). A missing file is left
// without a date rather than given a guessed one; it costs one failed stat per boot.
export async function backfillSynthesizedAt(): Promise<number> {
  let filled = 0;
  for (const table of [chapters, chapterVariants]) {
    const rows = await db
      .select({ id: table.id, audioPath: table.audioPath })
      .from(table)
      .where(and(isNotNull(table.audioPath), sql`${table.synthesizedWith}->>'at' is null`));
    for (const row of rows) {
      if (!row.audioPath) continue;
      const modified = await stat(row.audioPath).then((s) => s.mtime, () => null);
      if (!modified) continue;
      const updated = await db
        .update(table)
        .set({
          synthesizedWith: sql`coalesce(${table.synthesizedWith}, '{}'::jsonb) || jsonb_build_object('at', ${modified.toISOString()}::text)`,
        })
        // Still undated: the boot sweep resumes synthesis, and a chapter finished meanwhile has its own
        .where(and(eq(table.id, row.id), sql`${table.synthesizedWith}->>'at' is null`))
        .returning({ id: table.id });
      filled += updated.length;
    }
  }
  return filled;
}
