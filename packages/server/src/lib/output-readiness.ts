import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { WorkerUtils } from "graphile-worker";
import { db } from "../db.ts";
import { chapters, chapterVariants } from "../schema.ts";

export type OutputNeeds = "text" | "audio";

export const OUTPUT_WAIT_POLL_MS = 30_000;
// A stalled queue must not leave a job rescheduling itself forever; give up and export what exists
const OUTPUT_WAIT_MAX_MS = 24 * 60 * 60 * 1000;

export const assembleJobKey = (bookId: string, language?: string | null) =>
  `assemble:${bookId}:${language ?? "original"}`;
// Named chapters are part of the key: two exports of different chapters are two documents, and
// under one key the second replaced the first while it waited for narration.
export const documentJobKey = (bookId: string, format: string, language?: string | null, chapterIds?: readonly string[] | null) =>
  `assembleDocument:${bookId}:${format}:${language ?? "original"}${chapterIds?.length ? `:${createHash("sha1").update([...chapterIds].sort().join(",")).digest("hex").slice(0, 16)}` : ""}`;

// The chapters an output is made from: the ones a caller named, else the selection the book page
// keeps. An agent exporting one chapter used to deselect the other thirteen, one call each, in the
// person's own book.
export function outputChapters(bookId: string, chapterIds?: readonly string[] | null) {
  return and(eq(chapters.bookId, bookId), chapterIds?.length ? inArray(chapters.id, [...chapterIds]) : eq(chapters.selected, true));
}

// Inputs still moving. Failed and suspended count as settled — waiting for them to reach
// "done" would strand a deferred output on the first chapter that dies.
export async function inFlightInputs(
  bookId: string,
  language: string | null | undefined,
  needs: OutputNeeds,
  chapterIds?: readonly string[] | null,
): Promise<number> {
  if (!language) {
    if (needs === "text") return 0;
    const rows = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(
        outputChapters(bookId, chapterIds),
        inArray(chapters.status, ["pending", "normalizing", "synthesizing"]),
      ));
    return rows.length;
  }

  const variantFilter = needs === "audio"
    ? inArray(chapterVariants.audioStatus, ["pending", "synthesizing"])
    : inArray(chapterVariants.status, ["pending", "translating"]);
  const rows = await db
    .select({ id: chapterVariants.id })
    .from(chapterVariants)
    .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
    .where(and(
      outputChapters(bookId, chapterIds),
      eq(chapterVariants.key, language),
      variantFilter,
    ));
  return rows.length;
}

// Re-queues the job behind its own inputs and reports whether the caller should stand down.
// The queue row IS the deferral state: it survives restarts (sweep replays it), dedupes by
// jobKey against repeat clicks, and the UI reads run_at to show "waiting".
export async function deferUntilInputsSettle(opts: {
  identifier: "assemble" | "assembleDocument";
  payload: Record<string, unknown> & { bookId: string; waitingSince?: string; chapterIds?: string[] };
  jobKey: string;
  language: string | null | undefined;
  needs: OutputNeeds;
  addJob: WorkerUtils["addJob"];
  log: (msg: string) => Promise<void>;
}): Promise<boolean> {
  const pending = await inFlightInputs(opts.payload.bookId, opts.language, opts.needs, opts.payload.chapterIds);
  if (pending === 0) return false;

  const waitingSince = opts.payload.waitingSince ?? new Date().toISOString();
  if (Date.now() - new Date(waitingSince).getTime() > OUTPUT_WAIT_MAX_MS) {
    await opts.log(`Gave up waiting after 24h — ${pending} chapter(s) never finished, using what is ready`);
    return false;
  }
  if (!opts.payload.waitingSince) {
    await opts.log(`Waiting for ${pending} chapter${pending !== 1 ? "s" : ""} to finish before running`);
  }

  await opts.addJob(opts.identifier, { ...opts.payload, waitingSince }, {
    maxAttempts: 1,
    jobKey: opts.jobKey,
    jobKeyMode: "replace",
    runAt: new Date(Date.now() + OUTPUT_WAIT_POLL_MS),
  });
  return true;
}
