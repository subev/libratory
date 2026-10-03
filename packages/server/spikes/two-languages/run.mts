// Two Languages spike: pair a chapter with its translation, time every pair edge in each narration,
// optionally link words inside pairs, and write a self-contained viewer.
//
//   cd packages/server && node_modules/.bin/tsx spikes/two-languages/run.mts [flags]
//     --links=ids|quotes   ask the default LLM for word links (well under a cent for three chapters)
//     --paired             also run approach A, marker-paired translation (≈ a cent)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../src/db.ts";
import { chapters, chapterVariants } from "../../src/schema.ts";
import { env } from "../../src/env.ts";
import { stopEmbeddings } from "../../src/lib/embeddings.ts";
import { readSyncMap, type SyncMap } from "../../src/lib/sync-map.ts";
import { sentences, type Span } from "./segment.mts";
import { align, type Pair } from "./align.mts";
import { timeline, spanTiming, type Timeline } from "./timing.mts";
import { tokenize, TOKENIZER } from "./tokens.mts";
import type { LinkPair, LinkRun } from "./links.mts";
import { linkByIds } from "./links-ids.mts";
import { linkByQuotes } from "./links-quote.mts";
import { pairedTranslation, type PairedRun } from "./paired-translate.mts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(env.DATA_DIR, "tmp", "two-languages-spike");
const arg = (name: string) => process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))?.split("=")[1] ?? (process.argv.includes(`--${name}`) ? "" : null);
mkdirSync(OUT, { recursive: true });

// Grimm, English Kokoro narration + the Bulgarian lane on the free bg-mlx narrator
const TARGETS = [
  { chapterId: "97bf474a-b495-4ea3-9d1a-fc47b725c2cb", variantId: "7853bf0d-5449-492b-8605-1f9fe277d45b" }, // 27 Death and the Goose Boy
  { chapterId: "d99f79fd-4d1a-475c-a132-3c653cb08b41", variantId: "370a30bb-d566-428c-8d06-aec0ccb0a20e" }, // 5 The Wolf and the Seven Kids
  { chapterId: "52fda53c-5d74-4172-9552-215087c546fa", variantId: "9e5a2c9f-6ea3-4e92-b02a-60478f0b6c33" }, // 26 Little Red Cap
];
// Chapter 27's Bulgarian narrated through Cartesia on 2026-09-27, once while the app pinned sonic-3.5
// and once after it moved to sonic-3.6. Reused, never regenerated here: cartesia.ts pins its model.
const CARTESIA_TAKES = [
  { label: "Cartesia · Georgi · recorded on sonic-3.5", base: "bg-cartesia35-ch029" },
  { label: "Cartesia · Georgi · recorded on sonic-3.6", base: "bg-cartesia36-ch029" },
];

export type ChapterData = { title: string; srcText: string; tgtText: string; pairs: Pair[]; linkPairs: LinkPair[] };

const entries: unknown[] = [];
const report: Record<string, unknown> = {};
const chapterData: ChapterData[] = [];

for (const [n, target] of TARGETS.entries()) {
  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, target.chapterId));
  const [variant] = await db.select().from(chapterVariants).where(eq(chapterVariants.id, target.variantId));
  if (!chapter?.audioPath || !variant?.text || !variant.audioPath) throw new Error(`missing data for ${target.chapterId}`);
  const srcText = chapter.customText ?? chapter.cleanText ?? chapter.rawText ?? "";
  const tgtText = variant.text;
  const src = sentences(srcText, "en");
  const tgt = sentences(tgtText, "bg");

  const t0 = Date.now();
  const pairs = await align(src, srcText, tgt, tgtText);
  const alignMs = Date.now() - t0;
  const linkPairs: LinkPair[] = pairs
    .filter((p): p is Pair & { s: Span; t: Span } => p.status === "matched" && !!p.s && !!p.t)
    .map((p) => ({ id: p.id, s: p.s, t: p.t, sTokens: tokenize(srcText, p.s, "en"), tTokens: tokenize(tgtText, p.t, "bg") }));
  chapterData.push({ title: chapter.title, srcText, tgtText, pairs, linkPairs });

  const statuses: Record<string, number> = {};
  for (const p of pairs) statuses[p.status] = (statuses[p.status] ?? 0) + 1;
  const r: Record<string, unknown> = { sentences: { en: src.length, bg: tgt.length }, pairs: pairs.length, statuses, alignMs };

  let links: LinkRun | null = null;
  const method = arg("links");
  if (method === "ids" || method === "quotes") {
    links = await (method === "ids" ? linkByIds : linkByQuotes)(linkPairs, srcText, tgtText, { from: "English", to: "Bulgarian" });
    r.links = { method, links: links.links.length, answered: links.answered.length, missing: links.missing, invalid: links.invalid.length, tokensIn: links.tokensIn, tokensOut: links.tokensOut, ms: links.ms };
  }

  let paired: PairedRun | null = null;
  if (arg("paired") !== null) {
    paired = await pairedTranslation(src, srcText, "Bulgarian");
    r.paired = { blocks: paired.blocks, validFirstTry: paired.validFirstTry, problems: paired.problems, tokensIn: paired.tokensIn, tokensOut: paired.tokensOut };
  }

  const srcLane = timeline(srcText, (await readSyncMap(chapter.audioPath))!);
  const lanes: { label: string; audio: string; map: SyncMap }[] = [{ label: "Free narrator (bg-mlx)", audio: variant.audioPath, map: (await readSyncMap(variant.audioPath))! }];
  if (n === 0) {
    for (const take of CARTESIA_TAKES) {
      const mapPath = path.join(OUT, `${take.base}.sync.json`);
      if (existsSync(mapPath)) lanes.push({ label: take.label, audio: path.join(OUT, `${take.base}.wav`), map: JSON.parse(readFileSync(mapPath, "utf-8")) as SyncMap });
    }
  }

  for (const lane of lanes) {
    const tgtLane = timeline(tgtText, lane.map);
    const methods: Record<string, number> = {};
    const timed = pairs.map((p) => {
      const s = p.s && spanTiming(srcLane, p.s), t = p.t && spanTiming(tgtLane, p.t);
      for (const e of [t?.start, t?.end]) if (e) methods[e.method] = (methods[e.method] ?? 0) + 1;
      return { ...p, sTiming: s, tTiming: t };
    });
    entries.push({
      title: chapter.title,
      lane: lane.label,
      srcText, tgtText,
      srcAudio: chapter.audioPath, tgtAudio: lane.audio,
      srcWords: wordsOf(srcLane), tgtWords: wordsOf(tgtLane),
      tgtEdgeMethods: methods,
      stats: r,
      pairs: timed,
      tokens: Object.fromEntries(linkPairs.map((p) => [p.id, { s: p.sTokens, t: p.tTokens }])),
      tokenizer: TOKENIZER,
      links: links?.links ?? [],
      paired: paired && { ...(r.paired as object), groups: paired.groups.map((g) => ({ kind: `${g.to - g.from + 1}`, src: src.slice(g.from - 1, g.to).map((x) => srcText.slice(x.start, x.end)).join(" "), tgt: g.text })) },
    });
  }
  report[chapter.title] = r;
  console.log(chapter.title, JSON.stringify(r));
}

writeFileSync(path.join(OUT, "chapters.json"), JSON.stringify(chapterData));
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(entries));
writeFileSync(path.join(OUT, "view.html"), readFileSync(path.join(HERE, "view.template.html"), "utf-8").replace("__DATA__", () => JSON.stringify(entries)));
writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
console.log(`\nviewer: ${path.join(OUT, "view.html")}`);
stopEmbeddings();
process.exit(0);

function wordsOf(tl: Timeline) {
  return tl.words.map((w) => ({ start: w.start, end: w.end, startMs: w.startMs, endMs: w.endMs }));
}
