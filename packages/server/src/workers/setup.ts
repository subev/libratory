import { run, makeWorkerUtils, type Runner, type TaskList } from "graphile-worker";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { books } from "../schema.ts";
import { whenBundleInstalled } from "../lib/model-bundles.ts";
import { extract } from "./extract.ts";
import { normalize } from "./normalize.ts";
import { synthesize } from "./synthesize.ts";
import { assemble } from "./assemble.ts";
import { assembleDocument } from "./assemble-document.ts";
import { redetect } from "./redetect.ts";
import { propose } from "./propose.ts";
import { translate } from "./translate.ts";
import { translateTitles } from "./translate-titles.ts";
import { cleanup } from "./cleanup.ts";
import { rawExtract } from "./raw-extract.ts";
import { bookNote } from "./book-note.ts";
import { digest } from "./digest.ts";
import { synthesizeTranslation } from "./synthesize-translation.ts";
import { indexBook } from "./index-book.ts";
import { embedChunks } from "./embed-chunks.ts";
import { sweepStrandedWork } from "./sweep.ts";
import { env } from "../env.ts";
import { POOL_META, poolByName, poolConcurrency, runningJobsByPool, setPoolConcurrency, type PoolMeta, type PoolName } from "./pools.ts";

const connectionString = env.DATABASE_URL;

function logTask(name: string, payload: Record<string, unknown>) {
  const bookId = (payload.bookId as string)?.slice(0, 8) ?? "?";
  const chapterId = (payload.chapterId as string)?.slice(0, 8);
  const label = chapterId ? `${name} (book ${bookId}, ch ${chapterId})` : `${name} (book ${bookId})`;
  return {
    label,
    start() { console.log(`[worker] Starting ${label}`); },
    done(ms: number) { console.log(`[worker] Completed ${label} (${(ms / 1000).toFixed(1)}s)`); },
    fail(ms: number, err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[worker] Failed ${label} (${(ms / 1000).toFixed(1)}s): ${msg}`);
    },
  };
}

function wrapTask<P extends Record<string, unknown>>(
  name: string,
  fn: (payload: P, helpers: any) => Promise<void>,
) {
  return async (payload: unknown, helpers: any) => {
    const p = payload as P;
    const t = logTask(name, p as Record<string, unknown>);
    const start = Date.now();
    t.start();
    try {
      await fn(p, helpers);
      t.done(Date.now() - start);
    } catch (err) {
      t.fail(Date.now() - start, err);
      throw err;
    }
  };
}

// Each pool only claims its own task_identifiers, so GPU-bound TTS can't starve
// CPU-bound extraction or network-bound translation. POOL_META owns the names, the tasks
// and the configurable concurrency; the keys here have to match its `tasks` exactly.
type TasksOf<N extends PoolName> = Extract<PoolMeta, { name: N }>["tasks"][number];

const TASK_LISTS: { [N in PoolName]: Record<TasksOf<N>, TaskList[string]> } = {
  tts: {
    synthesize: wrapTask("synthesize", synthesize),
    synthesizeTranslation: wrapTask("synthesizeTranslation", synthesizeTranslation),
  },
  raw: {
    rawExtract: wrapTask("rawExtract", rawExtract),
  },
  extraction: {
    extract: wrapTask("extract", extract),
    redetect: wrapTask("redetect", (payload) => redetect(payload as any)),
    propose: wrapTask("propose", (payload) => propose(payload as any)),
  },
  prep: {
    normalize: wrapTask("normalize", normalize),
  },
  assembly: {
    assemble: wrapTask("assemble", (payload, helpers) => assemble(payload as any, helpers)),
    assembleDocument: wrapTask("assembleDocument", (payload, helpers) => assembleDocument(payload as any, helpers)),
  },
  index: {
    indexBook: wrapTask("indexBook", indexBook),
    embedChunks: wrapTask("embedChunks", (payload) => embedChunks(payload as any)),
  },
  translate: {
    translate: wrapTask("translate", translate),
    translateTitles: wrapTask("translateTitles", (payload) => translateTitles(payload as any)),
    cleanup: wrapTask("cleanup", (payload) => cleanup(payload as any)),
    bookNote: wrapTask("bookNote", (payload) => bookNote(payload as any)),
    digest: wrapTask("digest", (payload) => digest(payload as any)),
  },
};

function runPool(name: PoolName): Promise<Runner> {
  return run({
    connectionString,
    concurrency: poolConcurrency(poolByName(name)),
    noHandleSignals: false,
    taskList: TASK_LISTS[name] as TaskList,
    // We don't use graphile cron; an empty crontab stops the per-pool
    // "Failed to read crontab file" INFO line at startup
    crontab: "",
  });
}

let currentRunners = new Map<PoolName, Runner>();

// A bundle finishing is not only a UI state change: books dropped in before the download existed
// were parked as "waiting" rather than failed, and this is what makes that promise good. The
// download notice says "this unlocks itself when it lands, no restart" — for extraction the user
// clicks a button afterwards, but nobody is going to re-upload a book to get it indexed.
async function requeueWaitingWork(id: string): Promise<void> {
  if (id !== "search") return;
  const waiting = await db
    .select({ id: books.id })
    .from(books)
    .where(sql`${books.searchIndex}->>'status' = 'waiting'`);
  if (waiting.length === 0) return;

  const utils = await makeWorkerUtils({ connectionString });
  try {
    for (const { id: bookId } of waiting) {
      await utils.addJob("embedChunks", { bookId }, { maxAttempts: 1, jobKey: `embed:${bookId}`, jobKeyMode: "replace" });
    }
    console.log(`[worker] BGE-M3 landed — queued ${waiting.length} book(s) that were waiting for it`);
  } finally {
    await utils.release();
  }
}

export async function startWorker(): Promise<Runner[]> {
  whenBundleInstalled(requeueWaitingWork);

  // On a virgin database the seven pools race their concurrent schema installs
  // (duplicate pg_namespace key on first boot) — migrate once up front instead
  const utils = await makeWorkerUtils({ connectionString });
  await utils.release();
  // Before the runners start, so any lock in the jobs table is provably from a dead process
  try {
    await sweepStrandedWork();
  } catch (err) {
    console.error("[worker] Startup sweep failed:", err);
  }
  const started = await Promise.all(
    POOL_META.map(async (pool) => [pool.name, await runPool(pool.name)] as const),
  );
  currentRunners = new Map(started);
  return started.map(([, runner]) => runner);
}

// Replacing a runner is how a new concurrency takes effect. It is only safe on an idle pool —
// graphile's graceful shutdown kills whatever is still running after five seconds — so the
// caller has to have established that, and the check is repeated here against the race between
// the browser reading "idle" and the user clicking.
export async function applyPoolConcurrency(name: PoolName, concurrency: number): Promise<void> {
  const pool = poolByName(name);
  if (concurrency < 1 || concurrency > pool.max) {
    throw new Error(`${pool.label} takes a number between 1 and ${pool.max}`);
  }

  const running = (await runningJobsByPool())[name];
  if (running > 0) {
    throw new Error(
      `${pool.label} has ${running} job${running === 1 ? "" : "s"} running. Changing this restarts the pool, which would kill them — wait for them to finish, or stop them first.`,
    );
  }

  setPoolConcurrency(pool, concurrency);
  const existing = currentRunners.get(name);
  if (!existing) return;
  await existing.stop();
  currentRunners.set(name, await runPool(name));
  console.log(`[worker] Pool ${name} restarted at concurrency ${concurrency}`);
}

export async function stopWorker(): Promise<void> {
  await Promise.all([...currentRunners.values()].map((runner) => runner.stop()));
  currentRunners = new Map();
}
