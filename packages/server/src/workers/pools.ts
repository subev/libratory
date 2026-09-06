import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { env, envFilePath } from "../env.ts";
import { updateEnvFile } from "../lib/env-file.ts";

// The pools, and everything Settings needs to let someone change one safely. `max` is a hard
// ceiling rather than advice: these all run on the user's own machine, and the honest ceiling for
// a GPU-bound pool is lower than any number a free-text field would invite. `cautionAbove` is the
// softer line — allowed, but the user is told what it costs before they live with it.
export const POOL_META = [
  {
    name: "tts",
    label: "Speech synthesis",
    envVar: "WORKER_CONCURRENCY_TTS",
    tasks: ["synthesize", "synthesizeTranslation"],
    default: 2,
    max: 4,
    hint: "Reading chapters aloud. The local voices share one GPU, so this is how many chapters are spoken at once — not how fast each one is.",
    cautionAbove: 2,
    caution: "Past 2 the GPU is the queue: chapters finish no sooner, and a long book can run the machine out of video memory.",
  },
  {
    name: "raw",
    label: "Quick text extraction",
    envVar: "WORKER_CONCURRENCY_RAW",
    tasks: ["rawExtract"],
    default: 2,
    max: 6,
    hint: "The fast pdftotext pass on upload — about a second per book. Cheap to raise; it exists so a new upload never waits behind a long Marker run.",
  },
  {
    name: "extraction",
    label: "Full extraction (Marker)",
    envVar: "WORKER_CONCURRENCY_EXTRACTION",
    tasks: ["extract", "redetect", "propose"],
    default: 1,
    max: 3,
    hint: "OCR and layout for one book: minutes to half an hour, several GB of memory, and the GPU. Also runs chapter detection and proposals.",
    cautionAbove: 1,
    caution: "Two books extract side by side, but each one is slower than it would have been alone, and a large pair can exhaust memory and fail both.",
  },
  {
    name: "prep",
    label: "Text preparation",
    envVar: "WORKER_CONCURRENCY_PREP",
    tasks: ["normalize"],
    default: 2,
    max: 6,
    hint: "Cleaning text for the narrator — milliseconds of pattern matching. Costs nothing to raise.",
  },
  {
    name: "assembly",
    label: "Audiobook and document exports",
    envVar: "WORKER_CONCURRENCY_ASSEMBLY",
    tasks: ["assemble", "assembleDocument"],
    default: 1,
    max: 3,
    hint: "Stitching chapters into an M4B, and rendering PDF and EPUB. Disk- and CPU-bound, and mostly short.",
    cautionAbove: 1,
    caution: "Two exports at once both write large files; on a slow disk each takes longer than running them in turn.",
  },
  {
    name: "index",
    label: "Search indexing",
    envVar: "WORKER_CONCURRENCY_INDEX",
    tasks: ["indexBook", "embedChunks"],
    default: 1,
    max: 2,
    hint: "Making new text searchable. The embedding model sits on the same GPU as speech synthesis.",
    cautionAbove: 1,
    caution: "This shares the GPU with speech synthesis — raising it slows narration down while a book is being indexed.",
  },
  {
    name: "translate",
    label: "Translations, rewrites and digests",
    envVar: "WORKER_CONCURRENCY_TRANSLATE",
    tasks: ["translate", "translateTitles", "cleanup", "bookNote", "digest"],
    default: 3,
    max: 8,
    hint: "AI calls over the network, so the ceiling is the provider's rate limit rather than this machine.",
    cautionAbove: 5,
    caution: "Most providers start refusing requests above roughly five at a time, and a refused chapter is a failed job — it will not be retried.",
  },
] as const;

export type PoolMeta = (typeof POOL_META)[number];
export type PoolName = PoolMeta["name"];

export const POOL_NAMES = POOL_META.map((p) => p.name) as [PoolName, ...PoolName[]];

export function poolByName(name: PoolName): PoolMeta {
  return POOL_META.find((p) => p.name === name)!;
}

export function poolConcurrency(pool: PoolMeta): number {
  const configured = env[pool.envVar];
  return configured === undefined ? pool.default : Math.min(configured, pool.max);
}

export function setPoolConcurrency(pool: PoolMeta, concurrency: number): void {
  updateEnvFile(envFilePath, pool.envVar, String(concurrency));
  env[pool.envVar] = concurrency;
}

// A pool's concurrency is fixed when its runner is built, so changing it means replacing the
// runner — and graphile gives a job five seconds to finish before it kills it. Anything in
// flight is therefore the one thing that blocks a change, and the UI says so rather than
// quietly ending a half-hour extraction.
export async function runningJobsByPool(): Promise<Record<PoolName, number>> {
  const running = Object.fromEntries(POOL_META.map((p) => [p.name, 0])) as Record<PoolName, number>;

  const [probe] = (await db.execute(
    sql`SELECT to_regclass('graphile_worker._private_jobs') AS jobs_table`,
  )) as unknown as Array<{ jobs_table: string | null }>;
  if (!probe?.jobs_table) return running;

  const rows = (await db.execute(sql`
    SELECT t.identifier, count(*)::int AS running
    FROM graphile_worker._private_jobs j
    JOIN graphile_worker._private_tasks t ON t.id = j.task_id
    WHERE j.locked_at IS NOT NULL
    GROUP BY t.identifier
  `)) as unknown as Array<{ identifier: string; running: number }>;

  for (const { identifier, running: count } of rows) {
    const pool = POOL_META.find((p) => (p.tasks as readonly string[]).includes(identifier));
    if (pool) running[pool.name] += count;
  }
  return running;
}

export async function poolStatus() {
  const running = await runningJobsByPool();
  return POOL_META.map((pool) => {
    const concurrency = poolConcurrency(pool);
    const over = "cautionAbove" in pool && concurrency > pool.cautionAbove;
    return {
      name: pool.name,
      label: pool.label,
      hint: pool.hint,
      concurrency,
      default: pool.default,
      max: pool.max,
      running: running[pool.name],
      caution: over ? pool.caution : null,
    };
  });
}
