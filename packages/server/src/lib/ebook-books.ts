import { readFile } from "node:fs/promises";
import { db } from "../db.ts";
import { books, type Book } from "../schema.ts";
import { parseEpub } from "./epub-import.ts";
import { insertSuspendedChapters } from "./insert-chapters.ts";
import { normalizeForTts } from "./normalizer.ts";
import { detectLanguage } from "./detect-language.ts";
import { queueIndexBook } from "./search-index.ts";
import { appendLog } from "./log.ts";
import { ownFolderId } from "./pdf-books.ts";

export type CreateEbookBookInput = {
  epubPath: string;
  filename: string;
  title?: string | null;
  folderId?: string | null;
};

// The package's dc:language is a BCP 47 tag ("en-GB"); the app keeps the primary ISO 639-1 code
function packageLanguage(tag: string | null): string | null {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2}$/.test(primary) ? primary : null;
}

// An EPUB is already text in chapters, so it becomes a book with no PDF: no OCR, no layout pass and
// no chapter detection — its table of contents names the chapters. Parsing comes first so a file
// that cannot be read leaves no book behind.
export async function createEbookBook(bookId: string, input: CreateEbookBookInput, profileId: string): Promise<Book> {
  const parsed = parseEpub(await readFile(input.epubPath));
  const folderId = await ownFolderId(input.folderId, profileId);
  const allText = parsed.chapters.map((ch) => ch.text).join("\n");
  const title = input.title?.trim() || parsed.title || input.filename.replace(/\.epub$/i, "").replace(/[_-]/g, " ");

  const [book] = await db
    .insert(books)
    .values({
      id: bookId,
      title: title.slice(0, 500),
      kind: "ebook",
      author: parsed.author,
      description: parsed.description,
      // Publisher templates often leave the package language at a default, so the text decides first
      language: detectLanguage(allText) ?? packageLanguage(parsed.language),
      origin: { type: "ebook", filename: input.filename },
      voice: "kokoro:af_heart",
      skipSynthesis: true,
      folderId,
      profileId,
    })
    .returning();
  if (!book) throw new Error("Failed to create book");

  await appendLog(bookId, `Imported from EPUB "${input.filename}" (${parsed.chapters.length} chapters from its table of contents)`);
  await insertSuspendedChapters(
    bookId,
    parsed.chapters.map((ch) => ({
      title: ch.title,
      text: ch.text,
      cleanText: normalizeForTts(ch.text),
      pageStart: null,
      pageEnd: null,
      sourceBlocks: null,
    })),
    0,
    null,
  );
  await queueIndexBook(bookId);
  return book;
}
