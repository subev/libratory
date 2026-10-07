import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "../db.ts";
import { chapters, chapterVariants, type Chapter, type ChapterVariant } from "../schema.ts";
import { chapterText } from "./chapter-text.ts";
import { elevenLabsCreditsPerChar, elevenLabsQuota } from "./elevenlabs.ts";
import { parseTtsVoice } from "./tts.ts";

// Which chapters "Synthesize selected" queues, shared by the mutations and the estimate so the
// number shown before Start is the text that Start sends.
export const ORIGINAL_SYNTHESIZABLE: Chapter["status"][] = ["failed", "suspended", "pending", "done"];
export const VARIANT_TEXT_FOR_AUDIO: ChapterVariant["status"][] = ["done", "pending", "translating"];

export function variantAudioQueueable(audioStatus: ChapterVariant["audioStatus"]): boolean {
  return audioStatus !== "synthesizing" && audioStatus !== "pending";
}

export type SynthesisCost = {
  chapters: number;
  characters: number;
  provider: "elevenlabs" | "cartesia";
  credits: number;
  /** What the account has left; null where the provider will not say (Cartesia, to an ordinary key). */
  remaining: number | null;
  /** Some chapters' text is still being written, so the figure will grow. */
  partial: boolean;
};

// Cartesia bills Sonic at 1 credit per character (cartesia.ai/pricing, read 2026-10-06).
const CARTESIA_CREDITS_PER_CHAR = 1;

// Null for any voice that does not spend: local engines cost nothing per character.
export async function estimateSynthesisCost(input: {
  bookId: string;
  voice: string;
  key: string | null;
  chapterId?: string;
}): Promise<SynthesisCost | null> {
  let engine: ReturnType<typeof parseTtsVoice>["engine"];
  try {
    engine = parseTtsVoice(input.voice).engine;
  } catch {
    return null;
  }
  if (engine !== "elevenlabs" && engine !== "cartesia") return null;

  const [texts, quota] = await Promise.all([
    input.key === null ? originalTexts(input.bookId, input.chapterId) : variantTexts(input.bookId, input.key, input.chapterId),
    engine === "elevenlabs" ? elevenLabsQuota().catch(() => null) : null,
  ]);
  const characters = texts.reduce((n, t) => n + t.text.length, 0);
  const rate = engine === "elevenlabs" ? elevenLabsCreditsPerChar() : CARTESIA_CREDITS_PER_CHAR;
  return {
    chapters: texts.length,
    characters,
    provider: engine,
    credits: Math.ceil(characters * rate),
    remaining: quota?.remaining ?? null,
    partial: texts.some((t) => t.partial),
  };
}

async function originalTexts(bookId: string, chapterId?: string): Promise<{ text: string; partial: boolean }[]> {
  const rows = await db
    .select({ rawText: chapters.rawText, cleanText: chapters.cleanText, customText: chapters.customText })
    .from(chapters)
    .where(
      chapterId
        ? and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId))
        : and(eq(chapters.bookId, bookId), eq(chapters.selected, true), inArray(chapters.status, ORIGINAL_SYNTHESIZABLE)),
    )
    .orderBy(asc(chapters.index));
  return rows.map((r) => ({ text: chapterText(r), partial: false }));
}

async function variantTexts(bookId: string, key: string, chapterId?: string): Promise<{ text: string; partial: boolean }[]> {
  const rows = await db
    .select({ text: chapterVariants.text, status: chapterVariants.status, audioStatus: chapterVariants.audioStatus })
    .from(chapterVariants)
    .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
    .where(
      and(
        eq(chapters.bookId, bookId),
        eq(chapterVariants.key, key),
        chapterId ? eq(chapters.id, chapterId) : and(eq(chapters.selected, true), inArray(chapterVariants.status, VARIANT_TEXT_FOR_AUDIO)),
      ),
    );
  return rows
    .filter((r) => chapterId !== undefined || variantAudioQueueable(r.audioStatus))
    .map((r) => ({ text: r.text, partial: r.status !== "done" }));
}
