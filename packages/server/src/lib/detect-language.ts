import { franc } from "franc-min";
import { eq } from "drizzle-orm";

import { db } from "../db.ts";
import { books } from "../schema.ts";

// franc answers in ISO 639-3; the app's language list is ISO 639-1. Only the listed languages are
// candidates, which is what keeps a Bulgarian scan from coming back as Macedonian.
const ISO1_BY_ISO3: Record<string, string> = {
  arb: "ar", bul: "bg", cmn: "zh", hrv: "hr", ces: "cs", dan: "da", nld: "nl", eng: "en", fin: "fi", fra: "fr",
  deu: "de", ell: "el", heb: "he", hin: "hi", hun: "hu", ind: "id", ita: "it", jpn: "ja", kor: "ko", nob: "no",
  pes: "fa", pol: "pl", por: "pt", ron: "ro", rus: "ru", spa: "es", swe: "sv", tur: "tr", ukr: "uk", vie: "vi",
  srp: "sr", slk: "sk", slv: "sl",
};

const SAMPLE_CHARS = 20_000;
const MIN_CHARS = 200;

export function detectLanguage(text: string): string | null {
  const sample = text.slice(0, SAMPLE_CHARS);
  if (sample.trim().length < MIN_CHARS) return null;
  const iso3 = franc(sample, { only: Object.keys(ISO1_BY_ISO3), minLength: MIN_CHARS });
  return ISO1_BY_ISO3[iso3] ?? null;
}

// Fills the book's language from its text when nobody has set one; a set language is never touched.
export async function adoptDetectedLanguage(bookId: string, text: string, log: (msg: string) => Promise<void>): Promise<void> {
  const [book] = await db.select({ language: books.language }).from(books).where(eq(books.id, bookId));
  if (!book || book.language) return;
  const language = detectLanguage(text);
  if (!language) return;
  await db.update(books).set({ language, updatedAt: new Date() }).where(eq(books.id, bookId));
  await log(`Language from the text: ${language} — change it under "About this book" if that is wrong`);
}
