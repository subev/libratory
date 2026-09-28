// Scores both link prompts against hand-labelled gold for chapter 27, over several runs.
//
//   cd packages/server && node --import tsx spikes/two-languages/review/eval-links.mts [runs=3]
// Needs chapters.json from run.mts. Costs well under a cent per run on the default model.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../../../src/env.ts";
import type { ChapterData } from "../run.mts";
import type { Link, LinkRun } from "../links.mts";
import { linkByIds } from "../links-ids.mts";
import { linkByQuotes } from "../links-quote.mts";

type GoldLink = [number[], number[], "c" | "f" | "p"];
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(env.DATA_DIR, "tmp", "two-languages-spike");
const runs = Number(process.argv[2] ?? 3);

const chapter = (JSON.parse(readFileSync(path.join(OUT, "chapters.json"), "utf-8")) as ChapterData[])[0]!;
const gold = JSON.parse(readFileSync(path.join(HERE, "gold-ch27.json"), "utf-8")) as { pairs: Record<string, GoldLink[]> };

// Token pairs: a link {2,5}→{2} is the relations 2–2 and 5–2
const expand = (pairId: string, s: number[], t: number[]) => s.flatMap((a) => t.map((b) => `${pairId}:${a}-${b}`));
const sets = { content: new Set<string>(), sure: new Set<string>(), possible: new Set<string>() };
for (const [pairId, links] of Object.entries(gold.pairs)) {
  for (const [s, t, tag] of links) {
    for (const rel of expand(pairId, s, t)) {
      sets.possible.add(rel);
      if (tag !== "p") sets.sure.add(rel);
      if (tag === "c") sets.content.add(rel);
    }
  }
}

function score(run: LinkRun) {
  const predicted = new Set(run.links.flatMap((l: Link) => expand(l.pairId, l.s, l.t)));
  const hit = (set: Set<string>) => [...predicted].filter((r) => set.has(r)).length;
  // Link level, which does not punish a coarse phrase link for its token cross-product: a link is
  // wrong when none of its relations is acceptable; a one-word link is wrong when its relation is not
  const relationsOf = (l: Link) => expand(l.pairId, l.s, l.t);
  const single = run.links.filter((l) => l.s.length === 1 && l.t.length === 1);
  const inSure = hit(sets.sure), inPossible = hit(sets.possible);
  return {
    precision: +(inPossible / predicted.size).toFixed(3),
    recallSure: +(inSure / sets.sure.size).toFixed(3),
    recallContent: +(hit(sets.content) / sets.content.size).toFixed(3),
    // Alignment error rate (Och & Ney): 0 is perfect, sure/possible aware
    aer: +(1 - (inSure + inPossible) / (predicted.size + sets.sure.size)).toFixed(3),
    relations: predicted.size,
    links: run.links.length,
    phraseLinks: run.links.length - single.length,
    linksWithNothingRight: run.links.filter((l) => !relationsOf(l).some((r) => sets.possible.has(r))).length,
    wrongSingleWordLinks: single.filter((l) => !sets.possible.has(relationsOf(l)[0]!)).length,
    wrong: [...predicted].filter((r) => !sets.possible.has(r)),
    missing: run.missing, invalid: run.invalid,
    tokensIn: run.tokensIn, tokensOut: run.tokensOut, ms: run.ms,
  };
}

const languages = { from: "English", to: "Bulgarian" };
const results: Record<string, ReturnType<typeof score>[]> = { quotes: [], ids: [] };
const raw: Record<string, string[][]> = { quotes: [], ids: [] };
for (let r = 0; r < runs; r++) {
  const [q, i] = await Promise.all([
    linkByQuotes(chapter.linkPairs, chapter.srcText, chapter.tgtText, languages),
    linkByIds(chapter.linkPairs, chapter.srcText, chapter.tgtText, languages),
  ]);
  results.quotes!.push(score(q));
  results.ids!.push(score(i));
  raw.quotes!.push(q.batches.map((b) => b.raw));
  raw.ids!.push(i.batches.map((b) => b.raw));
}

const mean = (xs: number[]) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3);
const summary = Object.fromEntries(Object.entries(results).map(([method, rs]) => [method, {
  precision: mean(rs.map((x) => x.precision)),
  recallSure: mean(rs.map((x) => x.recallSure)),
  recallContent: mean(rs.map((x) => x.recallContent)),
  aer: mean(rs.map((x) => x.aer)),
  aerRange: [Math.min(...rs.map((x) => x.aer)), Math.max(...rs.map((x) => x.aer))],
  links: mean(rs.map((x) => x.links)),
  phraseLinks: mean(rs.map((x) => x.phraseLinks)),
  linksWithNothingRight: mean(rs.map((x) => x.linksWithNothingRight)),
  wrongSingleWordLinks: mean(rs.map((x) => x.wrongSingleWordLinks)),
  tokensIn: mean(rs.map((x) => x.tokensIn)),
  tokensOut: mean(rs.map((x) => x.tokensOut)),
  missingPairs: rs.map((x) => x.missing.length),
  invalidLines: rs.map((x) => x.invalid.length),
}]));
writeFileSync(path.join(OUT, "review-links.json"), JSON.stringify({ gold: { sure: sets.sure.size, content: sets.content.size, possible: sets.possible.size }, summary, results, raw }, null, 1));
console.log(JSON.stringify({ gold: { sure: sets.sure.size, content: sets.content.size, possible: sets.possible.size }, summary }, null, 1));
process.exit(0);
