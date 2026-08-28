import { db } from "../db.ts";
import { bookFiles } from "../schema.ts";
import { eq, asc } from "drizzle-orm";

export type BookRawText = {
  text: string;
  fileCount: number;
  missingCount: number;
};

export async function getBookRawText(bookId: string): Promise<BookRawText | null> {
  const files = await db
    .select({ index: bookFiles.index, filename: bookFiles.filename, rawText: bookFiles.rawText })
    .from(bookFiles)
    .where(eq(bookFiles.bookId, bookId))
    .orderBy(asc(bookFiles.index));

  const withText = files.filter((f) => f.rawText);
  if (withText.length === 0) return null;

  const [only] = withText;
  const text =
    withText.length === 1 && only?.rawText
      ? only.rawText
      : withText.map((f) => `File ${f.index + 1}: "${f.filename}"\n\n${f.rawText}`).join("\n\n---\n\n");

  return { text, fileCount: withText.length, missingCount: files.length - withText.length };
}
