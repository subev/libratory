import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db.ts";
import { books, devices, documents, shelfDownloads } from "../schema.ts";
import { fileSize } from "./disk-usage.ts";

// The shelf is derived, never curated: a profile's finished read-along and bilingual EPUBs, as
// they are. Hiding one is the only edit, and it hides the row, not the file.
export const SHELF_FORMATS = ["epub-sync", "epub-bilingual"] as const;
export type ShelfFormat = (typeof SHELF_FORMATS)[number];

export type ShelfDocument = {
  id: string;
  bookId: string;
  title: string;
  author: string | null;
  // The book's own language, a code; a document's is the translation's name
  bookLanguage: string | null;
  format: ShelfFormat;
  language: string | null;
  label: string;
  chapterCount: number;
  chapterSummary: string;
  bytes: number | null;
  createdAt: Date;
  hidden: boolean;
  downloadedBy: { deviceId: string; name: string }[];
};

export function newDeviceKey(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// "de" → "German", in English, from the platform rather than a list of our own
export function languageName(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? null;
  } catch {
    return null;
  }
}

// What the row says the file is: "German and English" for a bilingual EPUB, "German, read-along"
// for a synced one — the language first, because that is what a reader picks by.
export function editionLabel(format: ShelfFormat, bookLanguage: string | null, language: string | null): string {
  const original = languageName(bookLanguage);
  switch (format) {
    case "epub-bilingual":
      return original && language ? `${original} and ${language}` : (language ?? "Bilingual");
    case "epub-sync": {
      const spoken = language ?? original;
      return spoken ? `${spoken}, read-along` : "Read-along";
    }
    default: {
      const unhandled: never = format;
      throw new Error(`unhandled shelf format ${unhandled}`);
    }
  }
}

function isShelfFormat(format: string): format is ShelfFormat {
  return (SHELF_FORMATS as readonly string[]).includes(format);
}

export async function shelfDocuments(profileId: string, options: { includeHidden: boolean }): Promise<ShelfDocument[]> {
  const rows = await db
    .select({
      id: documents.id,
      bookId: documents.bookId,
      title: books.title,
      author: books.author,
      bookLanguage: books.language,
      format: documents.format,
      language: documents.language,
      chapterCount: documents.chapterCount,
      chapterSummary: documents.chapterSummary,
      outputPath: documents.outputPath,
      createdAt: documents.createdAt,
      hidden: documents.shelfHidden,
    })
    .from(documents)
    .innerJoin(books, eq(documents.bookId, books.id))
    .where(
      and(
        eq(books.profileId, profileId),
        inArray(documents.format, [...SHELF_FORMATS]),
        ...(options.includeHidden ? [] : [eq(documents.shelfHidden, false)]),
      ),
    )
    .orderBy(desc(documents.createdAt));

  const downloads = rows.length === 0
    ? []
    : await db
        .select({ documentId: shelfDownloads.documentId, deviceId: devices.id, name: devices.name })
        .from(shelfDownloads)
        .innerJoin(devices, eq(shelfDownloads.deviceId, devices.id))
        .where(inArray(shelfDownloads.documentId, rows.map((r) => r.id)));
  const downloadedBy = new Map<string, { deviceId: string; name: string }[]>();
  for (const d of downloads) {
    const list = downloadedBy.get(d.documentId) ?? [];
    list.push({ deviceId: d.deviceId, name: d.name });
    downloadedBy.set(d.documentId, list);
  }

  return Promise.all(
    rows.map(async ({ outputPath, format, ...row }) => {
      // The query already filtered to the two formats; the guard is what the type needs
      if (!isShelfFormat(format)) throw new Error(`unexpected shelf format ${format}`);
      return {
        ...row,
        format,
        label: editionLabel(format, row.bookLanguage, row.language),
        bytes: await fileSize(outputPath),
        downloadedBy: downloadedBy.get(row.id) ?? [],
      };
    }),
  );
}

// What a phone sees: the visible shelf grouped by book, each file an edition of it
export type ShelfBook = {
  id: string;
  title: string;
  author: string | null;
  language: string | null;
  editions: {
    documentId: string;
    format: ShelfFormat;
    language: string | null;
    label: string;
    chapterCount: number;
    bytes: number | null;
    createdAt: Date;
    downloaded: boolean;
  }[];
};

export function groupByBook(docs: ShelfDocument[], deviceId: string): ShelfBook[] {
  const byBook = new Map<string, ShelfBook>();
  for (const doc of docs) {
    const book = byBook.get(doc.bookId) ?? {
      id: doc.bookId,
      title: doc.title,
      author: doc.author,
      language: languageName(doc.bookLanguage),
      editions: [],
    };
    book.editions.push({
      documentId: doc.id,
      format: doc.format,
      language: doc.language,
      label: doc.label,
      chapterCount: doc.chapterCount,
      bytes: doc.bytes,
      createdAt: doc.createdAt,
      downloaded: doc.downloadedBy.some((d) => d.deviceId === deviceId),
    });
    byBook.set(doc.bookId, book);
  }
  return [...byBook.values()];
}

export async function shelfBookCount(profileId: string): Promise<number> {
  const docs = await shelfDocuments(profileId, { includeHidden: false });
  return new Set(docs.map((d) => d.bookId)).size;
}
