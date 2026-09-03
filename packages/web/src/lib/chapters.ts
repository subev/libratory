import type { ChapterRow, VariantRef } from "../components/ChapterTable.tsx";

// A chapter whose audio is on its way — it can be cancelled, but not queued or re-synthesized
export const SYNTH_BUSY = ["pending", "normalizing", "synthesizing"];

// The same for its text, which only a variant lane can be waiting on: the original's text is written
// by extraction, long before anything can ask to export it
export const TEXT_BUSY = ["translating", "rewriting"];

export function variantLabel(variant: { key: string; label: string | null }): string {
  return variant.label ?? variant.key;
}

export function chapterAudioUrl(chapter: ChapterRow): string {
  return chapter.audioUrl ?? `/audio/chapter/${chapter.id}`;
}

export function chapterAudioDownload(chapter: ChapterRow, variant?: VariantRef | null) {
  // Legacy chapters synthesized before the AAC switch are still .mp3 on disk
  const ext = chapter.audioPath?.match(/\.\w+$/)?.[0] ?? ".m4a";
  return {
    href: chapterAudioUrl(chapter),
    filename: `${chapter.index + 1} ${chapter.title}${variant ? ` (${variantLabel(variant)})` : ""}${ext}`.replace(/[\\/]/g, "-"),
  };
}
