import { beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/schema.ts";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

let adminSql: ReturnType<typeof postgres>;
let testSql: ReturnType<typeof postgres>;
let testDb: TestDatabase;
let currentDbName: string;

beforeAll(async () => {
  const adminUrl = inject("adminUrl");
  const templateDbName = inject("templateDbName");

  adminSql = postgres(adminUrl, { max: 1 });

  // Create unique test database from template
  currentDbName = `libratory_test_${randomUUID().replace(/-/g, "")}`;
  await adminSql.unsafe(`CREATE DATABASE "${currentDbName}" TEMPLATE "${templateDbName}"`);

  // Connect to test database
  const parsed = new URL(adminUrl);
  const testUrl = `postgres://${parsed.username}:${parsed.password}@${parsed.hostname}:${parsed.port}/${currentDbName}`;
  testSql = postgres(testUrl);
  testDb = drizzle(testSql, { schema });
});

afterAll(async () => {
  await testSql.end();

  // Wait for connections to drop, then drop test DB
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const active = await adminSql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = ${currentDbName} AND pid <> pg_backend_pid()
    `;
    if (Number(active[0]?.count ?? 0) === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  await adminSql.unsafe(`DROP DATABASE IF EXISTS "${currentDbName}"`);
  await adminSql.end();
});

export async function resetDb(db: TestDatabase) {
  await db.execute(sql`
    DO $$ BEGIN
      IF to_regclass('graphile_worker._private_jobs') IS NOT NULL THEN
        DELETE FROM graphile_worker._private_jobs;
      END IF;
    END $$`);
  await db.execute(sql`DELETE FROM notes`);
  await db.execute(sql`DELETE FROM assemblies`);
  await db.execute(sql`DELETE FROM documents`);
  await db.execute(sql`DELETE FROM chapter_translations`);
  await db.execute(sql`DELETE FROM chapters`);
  await db.execute(sql`DELETE FROM book_files`);
  await db.execute(sql`DELETE FROM book_logs`);
  await db.execute(sql`DELETE FROM books`);
  await db.execute(sql`DELETE FROM folders`);
  await db.execute(sql`DELETE FROM profiles WHERE id <> ${schema.DEFAULT_PROFILE_ID}`);
}

// Mirrors the real graphile-worker private schema (task_id FK, not a task_identifier column)
// so SQL that joins _private_tasks behaves the same in tests as in production.
export async function ensureGraphileTables(db: TestDatabase) {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS graphile_worker`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS graphile_worker._private_tasks (
      id serial PRIMARY KEY,
      identifier text NOT NULL UNIQUE
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS graphile_worker._private_jobs (
      id serial PRIMARY KEY,
      task_id int NOT NULL REFERENCES graphile_worker._private_tasks(id),
      payload json NOT NULL DEFAULT '{}',
      run_at timestamptz NOT NULL DEFAULT now(),
      attempts int NOT NULL DEFAULT 0,
      max_attempts int NOT NULL DEFAULT 1,
      locked_at timestamptz,
      locked_by text
    )`);
}

export async function insertJob(
  db: TestDatabase,
  identifier: string,
  payload: Record<string, unknown>,
  opts?: { lockedAt?: Date; attempts?: number; maxAttempts?: number },
) {
  await db.execute(sql`
    INSERT INTO graphile_worker._private_tasks (identifier) VALUES (${identifier})
    ON CONFLICT (identifier) DO NOTHING`);
  await db.execute(sql`
    INSERT INTO graphile_worker._private_jobs (task_id, payload, attempts, max_attempts, locked_at, locked_by)
    SELECT t.id, ${JSON.stringify(payload)}::json, ${opts?.attempts ?? 0}, ${opts?.maxAttempts ?? 1},
           ${opts?.lockedAt?.toISOString() ?? null}::timestamptz, ${opts?.lockedAt ? "worker-dead" : null}
    FROM graphile_worker._private_tasks t WHERE t.identifier = ${identifier}`);
}

export async function listJobs(db: TestDatabase) {
  const rows = await db.execute(sql`
    SELECT t.identifier, j.payload, j.locked_at
    FROM graphile_worker._private_jobs j
    JOIN graphile_worker._private_tasks t ON t.id = j.task_id
    ORDER BY j.id`);
  return rows as unknown as Array<{ identifier: string; payload: Record<string, unknown>; locked_at: Date | null }>;
}

export function getDb() {
  return testDb;
}

// Narrows a query result the test has already asserted the shape of; failing loudly beats
// a cascade of "possibly undefined" guards in every assertion.
export function row<T>(rows: T[], index = 0): T {
  const value = rows[index];
  if (!value) throw new Error(`expected a row at index ${index}, got ${rows.length}`);
  return value;
}
