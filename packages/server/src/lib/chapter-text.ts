import type { Chapter } from "../schema.ts";

// The text the app narrates, exports and reads, in the order every caller means by "the chapter"
export function chapterText(chapter: Pick<Chapter, "customText" | "cleanText" | "rawText">): string {
  return chapter.customText ?? chapter.cleanText ?? chapter.rawText ?? "";
}
