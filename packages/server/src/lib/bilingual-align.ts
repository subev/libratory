// Sentence alignment of a text and its translation: dynamic programming over BGE-M3 similarity,
// allowing up to four sentences on either side of a pair (the vecalign family of methods). The
// search always completes a path; whether a step of it is trustworthy is judged afterwards, against
// the chapter's own scores, and reported as a status rather than hidden.
import type { Span } from "./bilingual-segment.ts";

export type PairStatus = "matched" | "uncertain" | "source-only" | "target-only";
export type Pair = { id: string; s: Span | null; t: Span | null; score: number; status: PairStatus };

const MAX_GROUP = 4;
// Cost terms of the path search. They shape the path; they do not decide what is shown as a
// translation — the status checks below do, relative to the chapter.
const BASE = 0.45;
const MERGE_COST = 0.04;
const SKIP_COST = 0.3;
// A merged sentence must raise the pair's similarity by at least this much to belong in it
const MERGE_GAIN = 0.02;
// A pair this many robust deviations below the chapter's median similarity is uncertain
const OUTLIER_Z = 4;

type Vec = (side: "s" | "t", i: number, n: number) => number[];
type Step = { i: number; j: number; di: number; dj: number };

export function alignVectors(src: Span[], tgt: Span[], vectors: number[][]): Pair[] {
  if (src.length * tgt.length > 2_000_000) throw new Error("Chapter is too large for sentence alignment; split it into smaller chapters");
  const vec = groupVectors(src, tgt, vectors);
  const steps = search(src.length, tgt.length, vec).flatMap((step) => splitIdleMembers(step, vec));

  const scored = steps.map((st) => ({ st, score: st.di && st.dj ? cosine(vec("s", st.i, st.di), vec("t", st.j, st.dj)) : 0 }));
  const isOutlier = outlierTest(scored.filter((x) => x.st.di && x.st.dj).map((x) => x.score));

  return scored.map(({ st, score }, k) => ({
    id: `p${k + 1}`,
    s: st.di ? { start: required(src, st.i).start, end: required(src, st.i + st.di - 1).end } : null,
    t: st.dj ? { start: required(tgt, st.j).start, end: required(tgt, st.j + st.dj - 1).end } : null,
    score: +score.toFixed(3),
    status: !st.dj ? "source-only" : !st.di ? "target-only" : isOutlier(score) ? "uncertain" : "matched",
  }));
}

function search(N: number, M: number, vec: Vec): Step[] {
  const best = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(-Infinity));
  const back = Array.from({ length: N + 1 }, (): ([number, number] | undefined)[] => Array.from({ length: M + 1 }));
  required(best, 0)[0] = 0;

  for (let i = 0; i <= N; i++) for (let j = 0; j <= M; j++) {
    const here = required(required(best, i), j);
    if (here === -Infinity) continue;
    const step = (di: number, dj: number, gain: number) => {
      if (i + di > N || j + dj > M) return;
      const next = here + gain;
      if (next > required(required(best, i + di), j + dj)) { required(best, i + di)[j + dj] = next; required(back, i + di)[j + dj] = [di, dj]; }
    };
    step(1, 0, -SKIP_COST);
    step(0, 1, -SKIP_COST);
    for (let di = 1; di <= MAX_GROUP; di++) for (let dj = 1; dj <= MAX_GROUP; dj++) {
      // One side of a pair is always a single sentence or close to it; larger many:many never occurs
      if (Math.min(di, dj) > 2 || i + di > N || j + dj > M) continue;
      step(di, dj, cosine(vec("s", i, di), vec("t", j, dj)) - BASE - MERGE_COST * (di + dj - 2));
    }
  }

  const steps: Step[] = [];
  for (let i = N, j = M; i > 0 || j > 0;) {
    const [di, dj] = required(required(back, i), j);
    i -= di; j -= dj;
    steps.push({ i, j, di, dj });
  }
  return steps.reverse();
}

// A sentence merged into a pair must earn its place: if the pair is as similar without it, it has no
// counterpart here (a translation that dropped it) and is split out as unpaired. Only a first or last
// member can leave, so the pair stays a contiguous run of sentences.
function splitIdleMembers(step: Step, vec: Vec): Step[] {
  if (!step.di || !step.dj || step.di + step.dj === 2) return [step];
  const whole = cosine(vec("s", step.i, step.di), vec("t", step.j, step.dj));
  const trials: { rest: Step; out: Step; first: boolean }[] = [];
  if (step.di > 1) {
    trials.push({ rest: { ...step, i: step.i + 1, di: step.di - 1 }, out: { i: step.i, j: step.j, di: 1, dj: 0 }, first: true });
    trials.push({ rest: { ...step, di: step.di - 1 }, out: { i: step.i + step.di - 1, j: step.j + step.dj, di: 1, dj: 0 }, first: false });
  }
  if (step.dj > 1) {
    trials.push({ rest: { ...step, j: step.j + 1, dj: step.dj - 1 }, out: { i: step.i, j: step.j, di: 0, dj: 1 }, first: true });
    trials.push({ rest: { ...step, dj: step.dj - 1 }, out: { i: step.i + step.di, j: step.j + step.dj - 1, di: 0, dj: 1 }, first: false });
  }
  const best = trials
    .map((t) => ({ ...t, score: cosine(vec("s", t.rest.i, t.rest.di), vec("t", t.rest.j, t.rest.dj)) }))
    .sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < whole + MERGE_GAIN) return [step];
  const rest = splitIdleMembers(best.rest, vec);
  return best.first ? [best.out, ...rest] : [...rest, best.out];
}

// Robust outlier test against the chapter's own matched similarities (median and MAD), so it adapts
// to the embedder, the language pair and the text instead of trusting one absolute cutoff
function outlierTest(scores: number[]): (score: number) => boolean {
  if (scores.length < 5) return () => false;
  const middle = (xs: number[]) => required([...xs].sort((a, b) => a - b), Math.floor(xs.length / 2));
  const median = middle(scores);
  const mad = middle(scores.map((s) => Math.abs(s - median))) * 1.4826;
  return (score) => (median - score) / Math.max(mad, 0.02) > OUTLIER_Z;
}

// Each sentence is embedded once; a group is the length-weighted, normalised sum of its sentences, so
// a stray fragment ("Mr.") barely moves it. Embedding every window instead gave identical pairs on
// 158 of 158 at three times the embedding work.
function groupVectors(src: Span[], tgt: Span[], vectors: number[][]): Vec {
  const dimensions = vectors[0]?.length ?? 0;
  if (vectors.length !== src.length + tgt.length || dimensions === 0 || vectors.some((v) => v.length !== dimensions || v.some((x) => !Number.isFinite(x)))) throw new Error("Invalid sentence embedding vectors");
  const spans = [...src, ...tgt];
  const cache = new Map<string, number[]>();

  return (side, i, n) => {
    const key = `${side}${i}:${n}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const offset = side === "s" ? 0 : src.length;
    const sum = Array.from({ length: dimensions }, () => 0);
    for (let k = 0; k < n; k++) {
      const span = required(spans, offset + i + k);
      required(vectors, offset + i + k).forEach((x, d) => (sum[d] = required(sum, d) + x * (span.end - span.start)));
    }
    const norm = Math.hypot(...sum) || 1;
    const unit = sum.map((x) => x / norm);
    cache.set(key, unit);
    return unit;
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let d = 0; d < a.length; d++) dot += required(a, d) * required(b, d);
  return dot;
}

function required<T>(values: ArrayLike<T>, index: number): NonNullable<T> {
  const value = values[index];
  if (value === undefined || value === null) throw new Error("Invalid alignment path or vector index");
  return value;
}
