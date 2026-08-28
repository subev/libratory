import { z } from "zod";
import { quickAddJob } from "graphile-worker";
import { db } from "../db.ts";
import { books, chapters, type ChapterSource } from "../schema.ts";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { insertSuspendedChapters } from "./insert-chapters.ts";
import { normalizeForTts } from "./normalizer.ts";
import { queueIndexBook } from "./search-index.ts";
import { appendLog } from "./log.ts";
import { parseTtsVoice } from "./tts.ts";
import { env } from "../env.ts";

const connectionString = env.DATABASE_URL;

export const chapterInputSchema = z.object({
  title: z.string().min(1).max(500),
  text: z.string().min(1).max(5_000_000),
  url: z.string().url().optional(),
});

export const createBookInputSchema = z.object({
  title: z.string().min(1).max(500),
  folderId: z.string().uuid().optional(),
  client: z.string().min(1).max(100).optional(),
  voice: z.string().optional(),
  speed: z.number().min(0.5).max(2).optional(),
  chapters: z.array(chapterInputSchema).max(500).default([]),
  synthesize: z.boolean().default(false),
});

export const appendChaptersInputSchema = z.object({
  client: z.string().min(1).max(100).optional(),
  chapters: z.array(chapterInputSchema).min(1).max(500),
  synthesize: z.boolean().default(false),
});

type ChapterInput = z.infer<typeof chapterInputSchema>;

function chapterSource(ch: ChapterInput, client?: string): ChapterSource {
  return ch.url
    ? { kind: "url", url: ch.url, title: ch.title }
    : { kind: "api", ...(client ? { client } : {}) };
}

async function insertApiChapters(
  bookId: string,
  inputs: ChapterInput[],
  offset: number,
  client: string | undefined,
  synthesize: boolean,
) {
  await insertSuspendedChapters(
    bookId,
    inputs.map((ch) => ({
      title: ch.title,
      text: ch.text,
      // API text is already spoken prose — normalize inline so synthesis needs no worker roundtrip
      cleanText: normalizeForTts(ch.text),
      pageStart: null,
      pageEnd: null,
      sourceBlocks: null,
      source: chapterSource(ch, client),
    })),
    offset,
    null,
  );

  const inserted = await db
    .select({ id: chapters.id, index: chapters.index, title: chapters.title })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), gte(chapters.index, offset)))
    .orderBy(asc(chapters.index));

  if (synthesize && inserted.length > 0) {
    for (const ch of inserted) {
      await db.update(chapters).set({ status: "pending" }).where(eq(chapters.id, ch.id));
      await quickAddJob({ connectionString }, "synthesize", { chapterId: ch.id, bookId }, { maxAttempts: 1 });
    }
    await appendLog(bookId, `Queued ${inserted.length} chapter${inserted.length === 1 ? "" : "s"} for synthesis`);
  }

  await queueIndexBook(bookId);
  return inserted;
}

export async function createApiBook(
  input: z.infer<typeof createBookInputSchema>,
  profileId: string,
) {
  if (input.voice) parseTtsVoice(input.voice);

  const [book] = await db
    .insert(books)
    .values({
      title: input.title,
      kind: "api",
      skipSynthesis: true,
      origin: { type: "api", ...(input.client ? { client: input.client } : {}) },
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
      folderId: input.folderId,
      profileId,
    })
    .returning();

  if (!book) throw new Error("Failed to create book");
  await appendLog(book.id, `Created via API${input.client ? ` by ${input.client}` : ""} (${input.chapters.length} chapters)`);
  const inserted = await insertApiChapters(book.id, input.chapters, 0, input.client, input.synthesize);
  return { book, chapters: inserted };
}

export async function appendApiChapters(
  bookId: string,
  input: z.infer<typeof appendChaptersInputSchema>,
) {
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) return null;

  const [tail] = await db
    .select({ next: sql<number>`coalesce(max(${chapters.index}) + 1, 0)::int` })
    .from(chapters)
    .where(eq(chapters.bookId, bookId));
  const next = tail?.next ?? 0;

  await appendLog(bookId, `Appending ${input.chapters.length} chapter${input.chapters.length === 1 ? "" : "s"} via API${input.client ? ` by ${input.client}` : ""}`);
  const inserted = await insertApiChapters(bookId, input.chapters, next, input.client, input.synthesize);
  return { book, chapters: inserted };
}

export async function apiBookStatus(bookId: string) {
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) return null;

  const rows = await db
    .select({
      id: chapters.id,
      index: chapters.index,
      title: chapters.title,
      status: chapters.status,
      error: chapters.error,
      durationMs: chapters.durationMs,
      hasAudio: sql<boolean>`${chapters.audioPath} is not null`,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.index));

  return {
    id: book.id,
    title: book.title,
    kind: book.kind,
    status: book.status,
    outputReady: book.outputPath !== null,
    chapters: rows,
  };
}
