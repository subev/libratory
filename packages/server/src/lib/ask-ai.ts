import { inArray } from "drizzle-orm";
import { db } from "../db.ts";
import { chapters, type NoteScope } from "../schema.ts";
import { getBookRawText } from "./book-raw-text.ts";

export const BOOK_RAW_SYSTEM =
  "You are a careful reading assistant. You are given the full raw text of a book, extracted directly from its PDF (it may contain page headers, footers, and OCR artifacts). " +
  "Answer the user's request about this book using only the given text — do not invent facts that are not in it. " +
  "Respond in the language of the request unless asked otherwise. Format your answer in Markdown where it helps readability (lists, bold, short headings).";

export function chaptersSystem(count: number): string {
  const single = count === 1;
  return (
    `You are a careful reading assistant. You are given the full text of ${single ? "one book chapter" : `${count} book chapters`}. ` +
    `Answer the user's request about ${single ? "this chapter" : "these chapters"} using only the given text — do not invent facts that are not in it. ` +
    "Respond in the language of the request unless asked otherwise. Format your answer in Markdown where it helps readability (lists, bold, short headings)."
  );
}

export type AskScope =
  | { kind: "book-raw"; bookId: string }
  | { kind: "chapters"; chapterIds: string[] };

export type AskContext = {
  system: string;
  corpus: string;
  bookId: string;
  noteScope: NoteScope;
};

// Throws user-facing Error strings (they are rendered verbatim in the modal)
export async function buildAskContext(scope: AskScope): Promise<AskContext> {
  if (scope.kind === "book-raw") {
    const raw = await getBookRawText(scope.bookId);
    if (!raw) throw new Error("No raw text available for this book — the PDF may be scanned or encrypted");
    return {
      system: BOOK_RAW_SYSTEM,
      corpus: raw.text,
      bookId: scope.bookId,
      noteScope: { kind: "book-raw", files: raw.fileCount },
    };
  }

  const rows = await db
    .select()
    .from(chapters)
    .where(inArray(chapters.id, scope.chapterIds))
    .orderBy(chapters.index);
  const [firstChapter] = rows;
  if (!firstChapter) throw new Error("Chapters not found");

  return {
    system: chaptersSystem(rows.length),
    corpus: rows
      .map((ch) => `Chapter ${ch.index + 1}: "${ch.title}"\n\n${ch.customText ?? ch.cleanText ?? ch.rawText}`)
      .join("\n\n---\n\n"),
    bookId: firstChapter.bookId,
    noteScope: { kind: "chapters", chapters: rows.map((ch) => ({ id: ch.id, title: ch.title })) },
  };
}
