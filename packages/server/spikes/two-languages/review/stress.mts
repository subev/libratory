import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "../../../src/env.ts";
import { stopEmbeddings } from "../../../src/lib/embeddings.ts";
import { align } from "../align.mts";
import { sentences } from "../segment.mts";

const range = z.object({ start: z.number(), end: z.number() });
const entry = z.object({ srcText: z.string(), tgtText: z.string(), pairs: z.array(z.object({ s: range, t: range })) });
const dir = path.join(env.DATA_DIR, "tmp/two-languages-spike");
const [original] = z.array(entry).parse(JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8")));
const removed = original?.pairs[7];
if (!original || !removed) throw new Error("Saved first chapter and its eighth pair are required");
const results: unknown[] = [];
try {
  for (const replacement of ["", "Квантовият компютър изчислява сложна математическа задача."]) {
    const target = original.tgtText.slice(0, removed.t.start) + replacement + original.tgtText.slice(removed.t.end);
    const pairs = await align(sentences(original.srcText, "en"), original.srcText, sentences(target, "bg"), target);
    results.push({ replacement, affected: pairs.filter((p) => p.s && p.s.start < removed.s.end && p.s.end > removed.s.start)
      .map((p) => ({ ...p, source: p.s && original.srcText.slice(p.s.start, p.s.end), target: p.t && target.slice(p.t.start, p.t.end) })),
    unpaired: pairs.filter((p) => !p.s || !p.t).length });
  }
  writeFileSync(path.join(dir, "review-stress.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  stopEmbeddings();
}
