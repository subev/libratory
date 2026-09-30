import { sql } from "drizzle-orm";
import { db } from "../db.ts";

// The task identifiers of a book's jobs that are still owed: queued, waiting, or running. A job that
// failed stays in the table with its attempts spent (maxAttempts is 1 everywhere), so presence alone
// proves nothing — a failed assembly read as "queued" until the next restart swept it. A running job
// has spent its attempt too, which is why the lock counts as well.
export async function owedJobs(bookId: string): Promise<Set<string>> {
  const [probe] = (await db.execute(
    sql`SELECT to_regclass('graphile_worker._private_jobs') AS jobs_table`,
  )) as unknown as Array<{ jobs_table: string | null }>;
  if (!probe?.jobs_table) return new Set();
  const rows = (await db.execute(sql`
    SELECT DISTINCT t.identifier
    FROM graphile_worker._private_jobs j
    JOIN graphile_worker._private_tasks t ON t.id = j.task_id
    WHERE j.payload->>'bookId' = ${bookId} AND (j.locked_at IS NOT NULL OR j.attempts < j.max_attempts)
  `)) as unknown as Array<{ identifier: string }>;
  return new Set(rows.map((r) => r.identifier));
}
