import { randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { chapters, chapterVariants } from "../schema.ts";
import { bilingualContext } from "./bilingual-store.ts";
import { chapterText } from "./chapter-text.ts";
import { encodeToM4a } from "./ffmpeg.ts";
import { fileSha256 } from "./file-sha256.ts";
import { readSyncMap, syncMapPath } from "./sync-map.ts";
import { appendLog } from "./log.ts";

export const isLegacyAudio = (audioPath: string | null) => path.extname(audioPath ?? "").toLowerCase() === ".mp3";

// Only the explicit conversion action changes the active recordings. The MP3 originals stay intact.
export async function convertLegacyBilingualAudio(variantId: string) {
  const before = await bilingualContext(variantId);
  if (before.chapter.status !== "done" || before.variant.audioStatus === "pending" || before.variant.audioStatus === "synthesizing") {
    throw new Error("Finish or stop narration before converting recordings");
  }
  const converted: { side: "source" | "target"; original: string; audio: string; revision: string; syncRevision: string }[] = [];
  let published = false;
  try {
    for (const side of ["source", "target"] as const) {
      const original = side === "source" ? before.chapter.audioPath : before.variant.audioPath;
      if (!original || !isLegacyAudio(original)) continue;
      if (side === "target" && before.variant.audioStatus !== "done") throw new Error("Finish translation narration before converting it");
      if (!(await readSyncMap(original))) throw new Error("Recording has no usable timing map; narrate it again to enable accurate seeking");
      const audio = path.join(path.dirname(original), `${path.basename(original, path.extname(original))}.seek-${randomUUID()}.m4a`);
      const entry = { side, original, audio, revision: await fileSha256(original), syncRevision: await fileSha256(syncMapPath(original)) };
      converted.push(entry);
      await appendLog(before.chapter.bookId, `Bilingual audio: converting ${side === "source" ? "original" : before.variant.key} recording for accurate seeking; keeping the MP3 original`);
      await encodeToM4a(original, audio);
      await copyFile(syncMapPath(original), syncMapPath(audio));
    }
    if (converted.length === 0) return { converted: 0 };
    await db.transaction(async (tx) => {
      const [latest] = await tx.select({ chapter: chapters, variant: chapterVariants }).from(chapterVariants)
        .innerJoin(chapters, eq(chapters.id, chapterVariants.chapterId)).where(eq(chapterVariants.id, variantId)).for("update");
      if (!latest || latest.chapter.status !== before.chapter.status || latest.variant.audioStatus !== before.variant.audioStatus
        || latest.variant.status !== before.variant.status || latest.chapter.audioPath !== before.chapter.audioPath
        || latest.variant.audioPath !== before.variant.audioPath || chapterText(latest.chapter).trim() !== before.source
        || latest.variant.text.trim() !== before.target || latest.variant.updatedAt.getTime() !== before.variant.updatedAt.getTime()) {
        throw new Error("Text or narration changed during conversion; no recordings were replaced");
      }
      for (const entry of converted) {
        if (await fileSha256(entry.original) !== entry.revision || await fileSha256(syncMapPath(entry.original)) !== entry.syncRevision
          || await fileSha256(syncMapPath(entry.audio)) !== entry.syncRevision) {
          throw new Error("Recording or timing changed during conversion; no recordings were replaced");
        }
      }
      for (const entry of converted) {
        if (entry.side === "source") await tx.update(chapters).set({ audioPath: entry.audio }).where(eq(chapters.id, before.chapter.id));
        else await tx.update(chapterVariants).set({ audioPath: entry.audio, updatedAt: new Date() }).where(eq(chapterVariants.id, variantId));
      }
    });
    published = true;
    return { converted: converted.length };
  } finally {
    if (!published) for (const entry of converted) {
      await rm(entry.audio, { force: true });
      await rm(syncMapPath(entry.audio), { force: true });
    }
  }
}
