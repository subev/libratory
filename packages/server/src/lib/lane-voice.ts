import { eq } from "drizzle-orm";

import { db } from "../db.ts";
import { books } from "../schema.ts";
import { parseTtsVoice } from "./tts.ts";

// The voice a synthesis of this lane will use — a variant's own, else the book's, as the worker
// resolves it. Throws the voice's own error (a retired voice says what to pick instead) before a
// route clears any audio: the worker would fail the same way, after the chapter's audio was gone.
export async function assertLaneVoiceUsable(bookId: string, variantKey?: string): Promise<void> {
  const [book] = await db.select({ voice: books.voice, variantVoices: books.variantVoices }).from(books).where(eq(books.id, bookId));
  if (!book) throw new Error("Book not found");
  parseTtsVoice((variantKey ? book.variantVoices?.[variantKey]?.voice : undefined) ?? book.voice);
}
