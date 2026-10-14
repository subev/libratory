import { sql } from "drizzle-orm";
import { db } from "../db.ts";

// Measured in characters rather than words: whitespace splitting means nothing in Chinese or
// Japanese, and length() is free in SQL where a word split over every queued chapter is not.
const WINDOW_MS = 10 * 60_000;
// Longer than the slowest chunk any engine takes, so a slow CPU voice never reads as idle
const IDLE_MS = 5 * 60_000;
// A resumed run replays its cached chunks as progress events milliseconds apart
const REUSED_CHUNK_MS = 250;
const MIN_SPAN_MS = 30_000;
const MIN_SAMPLES = 3;

type Run = { chunk: number; at: number };
type Sample = { at: number; chars: number };

// Pool-wide throughput, not per chapter: the queue drains at whatever every running chapter
// produces together, and with two chapters on one GPU neither runs at its solo speed.
export function createThroughputMeter() {
  const runs = new Map<string, Run>();
  let samples: Sample[] = [];
  let activeSince: number | null = null;
  let lastEventAt = Number.NEGATIVE_INFINITY;

  return {
    progress(runKey: string, chunk: number, totalChunks: number, chars: number, now = Date.now()) {
      if (now - lastEventAt > IDLE_MS) {
        samples = [];
        runs.clear();
        activeSince = now;
      }
      lastEventAt = now;
      const prev = runs.get(runKey);
      if (chunk >= totalChunks) runs.delete(runKey);
      else runs.set(runKey, { chunk, at: now });
      // The first event of a run only marks where it starts: model loading preceded it
      if (!prev || chunk <= prev.chunk || totalChunks <= 0) return;
      if (now - prev.at < REUSED_CHUNK_MS) return;
      samples.push({ at: now, chars: (chars * (chunk - prev.chunk)) / totalChunks });
    },
    // Characters per second, or null until enough has been measured to say anything
    rate(now = Date.now()): number | null {
      if (activeSince === null || now - lastEventAt > IDLE_MS) return null;
      const from = Math.max(activeSince, now - WINDOW_MS);
      samples = samples.filter((s) => s.at > from);
      if (samples.length < MIN_SAMPLES || now - from < MIN_SPAN_MS) return null;
      const chars = samples.reduce((sum, s) => sum + s.chars, 0);
      return chars / ((now - from) / 1000);
    },
  };
}

export const synthesisThroughput = createThroughputMeter();

export type QueuedSynthesis = {
  bookId: string;
  chars: number;
  progress: string | null;
  running: boolean;
  // Graphile's pick order (priority, run_at, id); null when no job is owed yet, such as
  // translation audio waiting for its text
  order: [number, number, number] | null;
};

export type BookSynthesisEta = {
  charsLeft: number;
  charsAhead: number;
  chaptersAhead: number;
  charsPerSecond: number | null;
  seconds: number | null;
};

function remainingChars(item: QueuedSynthesis): number {
  const match = item.running ? item.progress?.match(/^(\d+)\/(\d+)$/) : null;
  if (!match) return item.chars;
  const total = Number(match[2]);
  return total > 0 ? item.chars * Math.max(0, 1 - Number(match[1]) / total) : item.chars;
}

function compareQueued(a: QueuedSynthesis, b: QueuedSynthesis): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  if (!a.order || !b.order) return a.order ? -1 : b.order ? 1 : 0;
  for (let i = 0; i < 3; i++) if (a.order[i] !== b.order[i]) return a.order[i]! - b.order[i]!;
  return 0;
}

// The book is done when its last queued chapter is, and everything picked before that chapter
// shares the pool with it — so the wait is all the text up to and including that chapter.
export function estimateBookSynthesis(queue: QueuedSynthesis[], bookId: string, charsPerSecond: number | null): BookSynthesisEta | null {
  const sorted = [...queue].sort(compareQueued);
  let last = -1;
  sorted.forEach((item, i) => { if (item.bookId === bookId) last = i; });
  if (last === -1) return null;
  let charsLeft = 0;
  let charsAhead = 0;
  let chaptersAhead = 0;
  for (const item of sorted.slice(0, last + 1)) {
    const chars = remainingChars(item);
    if (item.bookId === bookId) charsLeft += chars;
    else {
      charsAhead += chars;
      chaptersAhead++;
    }
  }
  return {
    charsLeft: Math.round(charsLeft),
    charsAhead: Math.round(charsAhead),
    chaptersAhead,
    charsPerSecond,
    seconds: charsPerSecond ? Math.round((charsLeft + charsAhead) / charsPerSecond) : null,
  };
}

export async function loadSynthesisQueue(): Promise<QueuedSynthesis[]> {
  const [probe] = (await db.execute(
    sql`SELECT to_regclass('graphile_worker._private_jobs') AS jobs_table`,
  )) as unknown as Array<{ jobs_table: string | null }>;
  if (!probe?.jobs_table) return [];
  const rows = (await db.execute(sql`
    WITH owed AS (
      SELECT DISTINCT ON (target) target, priority, run_at, id
      FROM (
        SELECT coalesce(j.payload->>'chapterId', j.payload->>'translationId') AS target,
          j.priority, extract(epoch FROM j.run_at) * 1000 AS run_at, j.id
        FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier IN ('normalize', 'synthesize', 'synthesizeTranslation')
          AND (j.locked_at IS NOT NULL OR j.attempts < j.max_attempts)
      ) jobs
      ORDER BY target, id
    ), items AS (
      SELECT c.id::text AS target, c.book_id, length(coalesce(c.custom_text, c.clean_text, c.raw_text)) AS chars,
        c.progress, c.status = 'synthesizing' AS running
      FROM chapters c
      WHERE c.status IN ('pending', 'normalizing', 'synthesizing')
      UNION ALL
      SELECT v.id::text, c.book_id, length(v.text), v.audio_progress, v.audio_status = 'synthesizing'
      FROM chapter_translations v
      JOIN chapters c ON c.id = v.chapter_id
      WHERE v.audio_status IN ('pending', 'synthesizing')
    )
    SELECT i.book_id, i.chars, i.progress, i.running, o.priority, o.run_at, o.id
    FROM items i
    LEFT JOIN owed o ON o.target = i.target
  `)) as unknown as Array<{
    book_id: string;
    chars: number | null;
    progress: string | null;
    running: boolean;
    priority: number | null;
    run_at: string | number | null;
    id: string | number | null;
  }>;
  return rows.map((r) => ({
    bookId: r.book_id,
    chars: Number(r.chars ?? 0),
    progress: r.progress,
    running: r.running,
    order: r.id === null ? null : [Number(r.priority ?? 0), Number(r.run_at ?? 0), Number(r.id)],
  }));
}
