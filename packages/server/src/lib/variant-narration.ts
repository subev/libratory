import { sql } from "drizzle-orm";
import { rm, unlink } from "node:fs/promises";

import { chapterVariants } from "../schema.ts";
import { syncMapPath } from "./sync-map.ts";
import { translationChunkPreviewDir } from "../workers/synthesize-translation.ts";

// A variant whose text is replaced keeps no narration: the old audio reads something else, and the
// export picks chapters by audio status, so left "done" it shipped the old audio beside the new text.
// A request to narrate ("pending") stays: it was made for whatever text the run ends with.
export const NO_NARRATION = {
  audioPath: null,
  audioDurationMs: null,
  audioStatus: sql<"pending" | null>`case when ${chapterVariants.audioStatus} = 'pending' then 'pending' end`,
  audioProgress: null,
  audioError: null,
  synthesizedWith: null,
} as const;

// Call after the row no longer points at these files, so a failure here leaves litter, never a
// row naming a file that is gone.
export async function removeVariantNarration(target: {
  bookId: string;
  key: string;
  chapterIndex: number;
  audioPath: string | null;
}): Promise<void> {
  if (target.audioPath) {
    await unlink(target.audioPath).catch(() => {});
    await unlink(syncMapPath(target.audioPath)).catch(() => {});
  }
  await rm(translationChunkPreviewDir(target.bookId, target.key, target.chapterIndex), { recursive: true, force: true }).catch(() => {});
}
