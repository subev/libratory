import { db } from "../db.ts";
import { books, chapters, bookFiles, type DigestJob } from "../schema.ts";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { llmChat, resolveLlm, type LlmModelDef } from "../lib/llm.ts";
import { describeError } from "../lib/errors.ts";
import { getBookSummaryText } from "../lib/book-source-text.ts";
import { estimateTokens } from "../lib/token-estimate.ts";
import { saveNote } from "../lib/notes.ts";
import { insertSuspendedChapters } from "../lib/insert-chapters.ts";
import { normalizeForTts } from "../lib/normalizer.ts";
import { appendLog } from "../lib/log.ts";
import { queueIndexBook } from "../lib/search-index.ts";

export type DigestPayload = {
  bookId: string;
};

const SYSTEM_PROMPT =
  "You are a careful reading assistant preparing one chapter of a spoken digest. You are given the full text of a book. " +
  "Follow the user's instructions for style and length. The output will be read aloud by a text-to-speech voice, so write " +
  "flowing prose: no bullet points, no headings, no markdown syntax. Use only facts from the given text.";

export async function digest(payload: DigestPayload) {
  const { bookId } = payload;
  const log = (msg: string) => appendLog(bookId, msg);

  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) throw new Error(`Book ${bookId} not found`);
  const origin = book.origin;
  if (origin?.type !== "digest") throw new Error("Book has no digest origin");

  const createdAt = book.digestJob?.createdAt ?? new Date().toISOString();
  const setJob = (job: Partial<DigestJob>) =>
    db
      .update(books)
      .set({
        digestJob: { status: "running", createdAt, ...job, updatedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(books.id, bookId));

  let def: LlmModelDef;
  try {
    def = (await resolveLlm(origin.model)).def;
  } catch (err) {
    const error = describeError(err);
    await setJob({ status: "failed", error });
    await log(`Digest failed: ${error}`);
    throw new Error(error, { cause: err });
  }

  await setJob({ status: "running" });

  // Sources already turned into chapters are skipped, so a re-queued job resumes where it stopped
  const existing = await db
    .select({ source: chapters.source, index: chapters.index })
    .from(chapters)
    .where(eq(chapters.bookId, bookId));
  const doneSourceIds = new Set(
    existing.map((ch) => (ch.source?.kind === "book" ? ch.source.bookId : null)).filter(Boolean),
  );
  let nextIndex = existing.reduce((max, ch) => Math.max(max, ch.index + 1), 0);

  const total = origin.sourceBookIds.length;
  let failures = 0;
  let processed = 0;

  for (const sourceBookId of origin.sourceBookIds) {
    processed++;
    if (doneSourceIds.has(sourceBookId)) continue;

    const [source] = await db.select({ title: books.title }).from(books).where(eq(books.id, sourceBookId));
    if (!source) {
      failures++;
      await log(`Digest ${processed}/${total}: source book no longer exists, skipping`);
      continue;
    }

    const text = await getBookSummaryText(sourceBookId);
    if (!text) {
      failures++;
      await log(`Digest ${processed}/${total}: "${source.title}" has no text (scanned PDF?), skipping`);
      continue;
    }

    const tokens = estimateTokens(text) + estimateTokens(origin.prompt);
    if (tokens > def.contextTokens) {
      failures++;
      await log(`Digest ${processed}/${total}: "${source.title}" exceeds the model's context (~${Math.round(tokens / 1000)}k tokens), skipping`);
      continue;
    }

    await setJob({ progress: `${processed}/${total}` });
    await log(`Digest ${processed}/${total}: summarizing "${source.title}"...`);

    let result: string;
    try {
      result = await llmChat(SYSTEM_PROMPT, `${origin.prompt}\n\n---\n${text}`, {
        model: origin.model,
        temperature: 0.7,
        timeoutMs: 600_000,
      });
    } catch (err) {
      failures++;
      await log(`Digest ${processed}/${total}: "${source.title}" failed — ${describeError(err)}`);
      continue;
    }

    const [counted] = await db
      .select({ fileCount: sql<number>`count(*)::int` })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, sourceBookId), isNotNull(bookFiles.rawText)));
    const fileCount = counted?.fileCount ?? 0;
    await saveNote({
      bookId: sourceBookId,
      prompt: origin.prompt,
      model: origin.model,
      result,
      scope: { kind: "book-raw", files: fileCount, digestBookId: bookId },
    });

    await insertSuspendedChapters(
      bookId,
      [{
        title: source.title,
        text: result,
        cleanText: normalizeForTts(result),
        pageStart: null,
        pageEnd: null,
        sourceBlocks: null,
        source: { kind: "book", bookId: sourceBookId, title: source.title },
      }],
      nextIndex,
      null,
    );
    nextIndex++;
  }

  const chapterCount = nextIndex;
  await db
    .update(books)
    .set({ totalChapters: chapterCount, status: "pending", error: null, updatedAt: new Date() })
    .where(eq(books.id, bookId));
  await queueIndexBook(bookId);

  if (failures > 0) {
    await setJob({ status: "failed", progress: `${total - failures}/${total}`, error: `${failures} of ${total} source book(s) failed — see the log` });
    await log(`Digest finished with ${failures} failed source(s) — chapters are suspended. Resume to retry the failed ones.`);
  } else {
    await setJob({ status: "done", progress: `${total}/${total}` });
    await log("Digest complete — chapters are suspended. Queue selected chapters when ready.");
  }
}
