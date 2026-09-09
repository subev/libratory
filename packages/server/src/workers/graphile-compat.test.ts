import { beforeAll, afterAll, expect, inject, it } from "vitest";
import { makeWorkerUtils, runOnce, type WorkerUtils } from "graphile-worker";
import { sql } from "drizzle-orm";
import { getDb, row } from "../../test/setup.ts";

let connectionString: string;
let worker: WorkerUtils;

beforeAll(async () => {
  // Use this file's disposable database, never the application queue. Unlike the route tests,
  // exercise Graphile's actual migrations and SQL instead of hand-made private tables.
  const result = await getDb().execute<{ name: string }>(sql`SELECT current_database() AS name`);
  const url = new URL(inject("adminUrl"));
  url.pathname = `/${row(result).name}`;
  connectionString = url.href;
  worker = await makeWorkerUtils({ connectionString });
  await worker.migrate();
});

afterAll(async () => {
  await worker?.release();
});

it("deduplicates output jobs, retains failed work, and never silently retries", async () => {
  const options = { jobKey: "assemble:compat", maxAttempts: 1 };
  const first = await worker.addJob("assemble", { revision: 1 }, options);
  const replacement = await worker.addJob("assemble", { revision: 2 }, options);
  expect(replacement.id).toBe(first.id);
  const failed = await worker.addJob("synthesize", {}, { maxAttempts: 1 });

  const assembled: unknown[] = [];
  let attempts = 0;
  const taskList = {
    assemble: async (payload: unknown) => { assembled.push(payload); },
    synthesize: async () => { attempts++; throw new Error("review before retrying"); },
  };
  await runOnce({ connectionString, taskList, concurrency: 2, noHandleSignals: true });
  // A second worker pass must leave the failed job alone.
  await runOnce({ connectionString, taskList, concurrency: 2, noHandleSignals: true });

  expect(assembled).toEqual([{ revision: 2 }]);
  expect(attempts).toBe(1);
  const remaining = await getDb().execute(sql`
    SELECT id::text, attempts, max_attempts, last_error, locked_at, locked_by
    FROM graphile_worker._private_jobs`);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toMatchObject({
    id: failed.id, attempts: 1, max_attempts: 1,
    last_error: "review before retrying", locked_at: null, locked_by: null,
  });
});
