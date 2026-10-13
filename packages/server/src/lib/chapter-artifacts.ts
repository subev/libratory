import { rm, unlink } from "node:fs/promises";

import { chapterChunkPreviewDir } from "./chunk-previews.ts";
import { syncMapPath } from "./sync-map.ts";

type ChapterArtifactTarget = {
  bookId: string;
  index: number;
  audioPath: string | null;
};

export async function removeChapterArtifacts(target: ChapterArtifactTarget): Promise<void> {
  if (target.audioPath) {
    await unlink(target.audioPath).catch(() => {});
    await unlink(syncMapPath(target.audioPath)).catch(() => {});
  }

  await rm(chapterChunkPreviewDir(target.bookId, target.index), { recursive: true, force: true }).catch(() => {});
}
