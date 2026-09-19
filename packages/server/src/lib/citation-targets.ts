import { eq, inArray } from "drizzle-orm";
import { db } from "../db.ts";
import { bookChunks, chapters } from "../schema.ts";
import { chapterText } from "./chapter-text.ts";
import { locateChunks } from "./chunk-previews.ts";
import { cuesFromSyncMap } from "./cues.ts";
import { readSyncMap, type SyncMap } from "./sync-map.ts";
import type { CitationSource } from "./chat-tools.ts";

// When the narration reaches a character of the chapter's text — the start of the cue holding it,
// or of the next one when the offset falls between two. Null when the narration was made from a
// text that no longer matches, which is what sends a citation back to the PDF.
export function cueTimeAtOffset(text: string, map: SyncMap, offset: number): number | null {
  const { cues } = cuesFromSyncMap(map);
  const ranges = locateChunks(text, cues.map((cue) => cue.text));
  for (const [i, range] of ranges.entries()) {
    if (range && range.end > offset) return cues[i]?.startMs ?? null;
  }
  return null;
}

// A cited passage in a narrated chapter opens in the reader at the moment it is spoken
export async function withReaderTargets(sources: CitationSource[]): Promise<CitationSource[]> {
  const cited = sources.filter((source) => source.kind === "chapter" && source.chapterId);
  if (cited.length === 0) return sources;

  const chunks = await db
    .select({ id: bookChunks.id, charStart: bookChunks.charStart })
    .from(bookChunks)
    .where(inArray(bookChunks.id, cited.map((source) => source.chunkId)));
  const startOf = new Map(chunks.map((chunk) => [chunk.id, chunk.charStart]));

  // Several citations usually land in one chapter; its sync map is read once
  const narrated = new Map<string, Promise<{ text: string; map: SyncMap } | null>>();
  const narration = (chapterId: string) => {
    let pending = narrated.get(chapterId);
    if (!pending) {
      pending = (async () => {
        const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
        const map = chapter?.audioPath ? await readSyncMap(chapter.audioPath) : null;
        return chapter && map ? { text: chapterText(chapter), map } : null;
      })();
      narrated.set(chapterId, pending);
    }
    return pending;
  };

  return Promise.all(sources.map(async (source) => {
    const start = startOf.get(source.chunkId);
    if (source.kind !== "chapter" || !source.chapterId || start === undefined) return source;
    const spoken = await narration(source.chapterId);
    return spoken ? { ...source, readAt: cueTimeAtOffset(spoken.text, spoken.map, start) } : source;
  }));
}
