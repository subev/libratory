import { sql } from "drizzle-orm";
import { quickAddJob } from "graphile-worker";
import { db } from "../db.ts";
import { appendLog } from "../lib/log.ts";
import { env } from "../env.ts";

const connectionString = env.DATABASE_URL;

// Every app job runs with maxAttempts: 1, so a job whose attempt died with the server
// (exhausted, or still locked by a dead worker) will never run again on its own. This
// runs once at boot, before this process's runner starts, so any lock it sees is orphaned.
export async function sweepStrandedWork() {
  const [probe] = (await db.execute(
    sql`SELECT to_regclass('graphile_worker._private_jobs') AS jobs_table`,
  )) as unknown as Array<{ jobs_table: string | null }>;
  if (!probe?.jobs_table) return;

  const recoveredByBook = new Map<string, number>();
  const bump = (bookId: string) => recoveredByBook.set(bookId, (recoveredByBook.get(bookId) ?? 0) + 1);

  const deadJobs = (await db.execute(sql`
    DELETE FROM graphile_worker._private_jobs j
    USING graphile_worker._private_tasks t
    WHERE t.id = j.task_id
      AND t.identifier IN ('normalize', 'synthesize', 'translate', 'translateTitles', 'synthesizeTranslation', 'assemble', 'assembleDocument', 'cleanup', 'extract', 'indexBook', 'embedChunks', 'digest', 'propose', 'redetect', 'bookNote')
      AND (j.locked_at IS NOT NULL OR j.attempts >= j.max_attempts)
    RETURNING t.identifier, j.payload, j.locked_at
  `)) as unknown as Array<{ identifier: string; payload: Record<string, unknown>; locked_at: string | null }>;

  // Assemblies and document exports have no per-row state to recover from; replay the dead job's own payload.
  const replayedAssembleBooks: string[] = [];
  for (const job of deadJobs.filter((j) => j.identifier === "assemble" || j.identifier === "assembleDocument")) {
    await quickAddJob({ connectionString }, job.identifier, job.payload, { maxAttempts: 1 });
    if (typeof job.payload.bookId === "string") {
      replayedAssembleBooks.push(job.payload.bookId);
      bump(job.payload.bookId);
    }
  }

  // Digest skips already-summarized sources, so replaying one that died mid-run resumes it.
  // Only locked jobs (killed with the server) — old exhausted ones were finished or abandoned.
  for (const job of deadJobs.filter((j) => j.identifier === "digest" && j.locked_at !== null)) {
    await quickAddJob({ connectionString }, "digest", job.payload, { maxAttempts: 1 });
    if (typeof job.payload.bookId === "string") bump(job.payload.bookId);
  }

  // Index jobs are hash-skipping (chunking) and embedding-IS-NULL-resumable, so a dead
  // one restarts from where it stopped; replay as indexBook either way (it chains embed).
  for (const job of deadJobs.filter((j) => j.identifier === "indexBook" || j.identifier === "embedChunks")) {
    const bookId = job.payload.bookId;
    if (typeof bookId !== "string") continue;
    await quickAddJob({ connectionString }, "indexBook", { bookId }, {
      maxAttempts: 1,
      jobKey: `index:${bookId}`,
      jobKeyMode: "replace",
    });
  }

  await db.execute(sql`
    UPDATE books SET status = 'done', updated_at = now()
    WHERE status = 'assembling'
      AND id::text NOT IN (SELECT json_array_elements_text(${JSON.stringify(replayedAssembleBooks)}::json))
      AND id::text NOT IN (
        SELECT j.payload->>'bookId' FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier IN ('assemble', 'assembleDocument') AND j.payload->>'bookId' IS NOT NULL)
  `);

  // Extraction can't resume mid-file and marker runs are long — mark stranded ones
  // failed instead of silently re-running; the user retries via re-extract.
  const strandedFiles = (await db.execute(sql`
    UPDATE book_files bf SET status = 'failed', error = 'Interrupted by server restart — re-extract to retry'
    WHERE bf.status IN ('extracting', 'pending')
      AND bf.book_id::text NOT IN (
        SELECT j.payload->>'bookId' FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'extract' AND j.payload->>'bookId' IS NOT NULL)
    RETURNING bf.book_id
  `)) as unknown as Array<{ book_id: string }>;

  await db.execute(sql`
    UPDATE books SET status = 'failed', error = 'Extraction interrupted by server restart', updated_at = now()
    WHERE status = 'extracting'
      AND id::text NOT IN (
        SELECT j.payload->>'bookId' FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier IN ('extract', 'redetect') AND j.payload->>'bookId' IS NOT NULL)
  `);

  // Proposals and book notes are cheap to re-trigger — mark stranded ones failed
  // instead of silently re-running LLM calls the user may no longer want
  await db.execute(sql`
    UPDATE books SET chapter_proposal = chapter_proposal || jsonb_build_object('status', 'failed', 'error', 'Interrupted by server restart — propose again to retry'), updated_at = now()
    WHERE chapter_proposal->>'status' = 'running'
      AND id::text NOT IN (
        SELECT j.payload->>'bookId' FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'propose' AND j.payload->>'bookId' IS NOT NULL)
  `);

  await db.execute(sql`
    UPDATE books SET note_job = note_job || jsonb_build_object('status', 'failed', 'error', 'Interrupted by server restart — ask again to retry', 'updatedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), updated_at = now()
    WHERE note_job->>'status' IN ('queued', 'running')
      AND id::text NOT IN (
        SELECT j.payload->>'bookId' FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'bookNote' AND j.payload->>'bookId' IS NOT NULL)
  `);

  const strandedFilesByBook = new Map<string, number>();
  for (const f of strandedFiles) {
    strandedFilesByBook.set(f.book_id, (strandedFilesByBook.get(f.book_id) ?? 0) + 1);
  }
  for (const [bookId, count] of strandedFilesByBook) {
    await appendLog(bookId, `${count} interrupted extraction(s) marked failed after server restart — use re-extract to retry`);
  }

  const strandedChapters = (await db.execute(sql`
    UPDATE chapters c SET status = 'pending', error = NULL
    WHERE c.status IN ('pending', 'normalizing', 'synthesizing')
      AND c.id::text NOT IN (
        SELECT j.payload->>'chapterId' FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier IN ('normalize', 'synthesize') AND j.payload->>'chapterId' IS NOT NULL)
    RETURNING c.id, c.book_id, c.clean_text IS NOT NULL AS has_clean_text
  `)) as unknown as Array<{ id: string; book_id: string; has_clean_text: boolean }>;

  for (const ch of strandedChapters) {
    if (ch.has_clean_text) {
      await quickAddJob({ connectionString }, "synthesize", { chapterId: ch.id, bookId: ch.book_id, resume: true }, { maxAttempts: 1 });
    } else {
      await quickAddJob({ connectionString }, "normalize", { chapterId: ch.id, bookId: ch.book_id }, { maxAttempts: 1 });
    }
    bump(ch.book_id);
  }

  const strandedTranslations = (await db.execute(sql`
    UPDATE chapter_translations ct SET status = 'pending', error = NULL, updated_at = now()
    FROM chapters c
    WHERE c.id = ct.chapter_id
      AND ct.status IN ('pending', 'translating')
      AND ct.id::text NOT IN (
        SELECT j.payload->>'translationId' FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'translate' AND j.payload->>'translationId' IS NOT NULL)
    RETURNING ct.id, c.book_id
  `)) as unknown as Array<{ id: string; book_id: string }>;

  for (const tr of strandedTranslations) {
    await quickAddJob({ connectionString }, "translate", { translationId: tr.id, bookId: tr.book_id }, { maxAttempts: 1 });
    bump(tr.book_id);
  }

  const strandedCleanups = (await db.execute(sql`
    UPDATE chapters c SET cleanup = (c.cleanup || jsonb_build_object('status', 'pending', 'updatedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) - 'error'
    WHERE c.cleanup->>'status' IN ('pending', 'cleaning')
      AND c.id::text NOT IN (
        SELECT j.payload->>'chapterId' FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'cleanup' AND j.payload->>'chapterId' IS NOT NULL)
    RETURNING c.id, c.book_id
  `)) as unknown as Array<{ id: string; book_id: string }>;

  for (const ch of strandedCleanups) {
    await quickAddJob({ connectionString }, "cleanup", { chapterId: ch.id, bookId: ch.book_id }, { maxAttempts: 1 });
    bump(ch.book_id);
  }

  // Only finished translations: audio_status='pending' on an unfinished one is the deferred
  // marker the translate worker resolves itself when the translation completes.
  const strandedAudio = (await db.execute(sql`
    UPDATE chapter_translations ct SET audio_status = 'pending', audio_error = NULL, updated_at = now()
    FROM chapters c
    WHERE c.id = ct.chapter_id
      AND ct.status = 'done'
      AND ct.audio_status IN ('pending', 'synthesizing')
      AND ct.id::text NOT IN (
        SELECT j.payload->>'translationId' FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'synthesizeTranslation' AND j.payload->>'translationId' IS NOT NULL)
    RETURNING ct.id, c.book_id
  `)) as unknown as Array<{ id: string; book_id: string }>;

  for (const tr of strandedAudio) {
    await quickAddJob({ connectionString }, "synthesizeTranslation", { translationId: tr.id, bookId: tr.book_id, resume: true }, { maxAttempts: 1 });
    bump(tr.book_id);
  }

  for (const [bookId, count] of recoveredByBook) {
    await appendLog(bookId, `Recovered ${count} interrupted job${count === 1 ? "" : "s"} after server restart`);
  }
  const total = [...recoveredByBook.values()].reduce((a, b) => a + b, 0);
  if (total > 0 || deadJobs.length > 0) {
    console.log(`[worker] Startup sweep: purged ${deadJobs.length} dead job(s), requeued ${total} stranded job(s)`);
  }
}
