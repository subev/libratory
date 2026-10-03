import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "../../../src/env.ts";
import { timeline, spanTiming } from "../timing.mts";

const range = z.object({ start: z.number(), end: z.number() });
const entries = z.array(z.object({ lane: z.string(), tgtText: z.string(), pairs: z.array(z.object({ t: range.nullable() })) }));
const word = z.object({ text: z.string(), after: z.string(), startMs: z.number(), endMs: z.number() });
const syncMap = z.object({ version: z.union([z.literal(1), z.literal(2)]), totalMs: z.number(),
  chunks: z.array(z.object({ text: z.string(), startMs: z.number(), endMs: z.number(), words: z.array(word).optional() })) });
const dir = path.join(env.DATA_DIR, "tmp/two-languages-spike");
const saved = entries.parse(JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8")));
const reports: unknown[] = [];
for (const take of ["35", "36"]) {
  const entry = saved.find((e) => e.lane.includes(`sonic-3.${take.slice(1)}`));
  if (!entry) throw new Error(`Missing take ${take}`);
  const map = syncMap.parse(JSON.parse(readFileSync(path.join(dir, `bg-cartesia${take}-ch029.sync.json`), "utf8")));
  const full = timeline(entry.tgtText, map);
  const coarse = timeline(entry.tgtText, { ...map, chunks: map.chunks.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })) });
  const fullErrors: number[] = [], coarseErrors: number[] = [];
  for (const pair of entry.pairs) {
    if (!pair.t) continue;
    const t = pair.t;
    const words = full.words.filter((w) => w.start < t.end && w.end > t.start);
    const first = words[0], last = words.at(-1);
    if (!first || !last) continue;
    for (const [tl, errors] of [[full, fullErrors], [coarse, coarseErrors]] as const) {
      const actual = spanTiming(tl, t);
      errors.push(Math.abs((actual.start.ms ?? Number.NaN) - first.startMs), Math.abs((actual.end.ms ?? Number.NaN) - last.endMs));
    }
  }
  const stats = (errors: number[]) => {
    const sorted = errors.toSorted((a, b) => a - b);
    return { n: errors.length, nonzero: errors.filter((e) => e > 0).length,
      meanMs: errors.reduce((a, b) => a + b, 0) / errors.length,
      p90Ms: sorted[Math.ceil(errors.length * 0.9) - 1], maxMs: sorted.at(-1) };
  };
  reports.push({ take, reportedWordEdges: stats(fullErrors), maskedWordsSameRecording: stats(coarseErrors) });
}
writeFileSync(path.join(dir, "review-timing.json"), JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports, null, 2));
