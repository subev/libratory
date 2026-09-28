import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { parseFile } from "music-metadata";
import { env } from "../../../src/env.ts";
import { BILINGUAL_FORMAT, readBilingualDocument, textRevision, type BilingualDocument, type BilingualLane } from "../../../src/lib/bilingual-format.ts";
import { buildReadaloudEpub } from "../../../src/lib/readaloud-epub.ts";
import { READER_FORMAT, type ReaderCues } from "../../../src/lib/reader-format.ts";
import { readSyncMap, type SyncMap } from "../../../src/lib/sync-map.ts";
import { timeline, spanTiming } from "../timing.mts";

const call = promisify(execFile);
const base = path.resolve(env.DATA_DIR, "tmp/two-languages-spike");
const out = path.resolve(env.DATA_DIR, "tmp/bilingual-reader");
await mkdir(out, { recursive: true });
const span = z.object({ start: z.number().int(), end: z.number().int() });
const token = span.extend({ id: z.number().int() });
const edge = z.object({ method: z.enum(["provider-word", "chunk-boundary", "interpolated", "unavailable"]), ms: z.number().nullable() });
const timing = z.object({ start: edge, end: edge });
const pair = z.object({ id: z.string(), s: span.nullable(), t: span.nullable(), status: z.enum(["matched", "uncertain", "source-only", "target-only"]), sTiming: timing, tTiming: timing });
const link = z.object({ pairId: z.string(), s: z.array(z.number()), t: z.array(z.number()) });
const word = span.extend({ startMs: z.number(), endMs: z.number() });
const saved = z.object({
  title: z.string(), lane: z.string(), srcText: z.string(), tgtText: z.string(), srcAudio: z.string(), tgtAudio: z.string(),
  srcWords: z.array(word), tgtWords: z.array(word), pairs: z.array(pair), tokenizer: z.string(), links: z.array(link),
  tokens: z.record(z.string(), z.object({ s: z.array(token), t: z.array(token) })),
  stats: z.object({ links: z.object({ missing: z.array(z.string()), invalid: z.number() }) }),
});
type Saved = z.infer<typeof saved>;
const results = z.array(saved).parse(JSON.parse(await readFile(path.join(base, "results.json"), "utf8")));
const real = results.find((r) => r.tgtAudio.includes("cartesia36"));
if (!real) throw new Error("Saved Cartesia chapter missing; no synthesis will be started");

async function exportExample(input: Saved, key: string, sourceLanguage: string, targetLanguage: string, notes: string[]) {
  const chapterId = `example-${key}`;
  const ids = { s: new Map<string, number>(), t: new Map<string, number>() };
  const makeLane = async (side: "s" | "t"): Promise<BilingualLane> => {
    const text = side === "s" ? input.srcText : input.tgtText;
    const audioPath = side === "s" ? input.srcAudio : input.tgtAudio;
    const dest = path.join(out, `${key}-${side}.m4a`);
    await call("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", audioPath, "-c:a", "aac", "-b:a", "128k", dest]);
    const totalMs = Math.round(((await parseFile(dest)).format.duration ?? 0) * 1000);
    const tokens: BilingualLane["tokens"] = [];
    for (const p of input.pairs) for (const t of input.tokens[p.id]?.[side] ?? []) {
      const id = tokens.length;
      ids[side].set(`${p.id}:${t.id}`, id);
      tokens.push({ id, range: [t.start, t.end] });
    }
    const anchors: unknown[] = input.pairs.flatMap((p) => {
      const range = p[side], times = side === "s" ? p.sTiming : p.tTiming;
      return range ? [{ range: [range.start, range.end], kind: "passage", ...times }] : [];
    });
    for (const w of side === "s" ? input.srcWords : input.tgtWords) anchors.push({ range: [w.start, w.end], kind: "word", start: { method: "provider-word", ms: w.startMs }, end: { method: "provider-word", ms: w.endMs } });
    return { id: side === "s" ? "original" : key, language: side === "s" ? sourceLanguage : targetLanguage,
      text, textRevision: await textRevision(text), tokens,
      narration: { revision: createHash("sha256").update(await readFile(dest)).digest("hex"), audio: side === "s" ? "../audio/ch000.m4a" : `audio/${key}.m4a`, totalMs,
        anchors: anchors as NonNullable<BilingualLane["narration"]>["anchors"],
        qualityNotes: side === "s" ? ["Provider timings; acoustic accuracy has not been independently verified."] : notes } };
  };
  const source = await makeLane("s"), target = await makeLane("t");
  const mappedIds = (side: "s" | "t", pair: string, tokens: number[]) => tokens.map((id) => {
    const mapped = ids[side].get(`${pair}:${id}`);
    if (mapped === undefined) throw new Error(`Missing token ${side}/${pair}/${id}`);
    return mapped;
  });
  const doc: BilingualDocument = await readBilingualDocument({ format: BILINGUAL_FORMAT, chapterId, key, tokenizer: input.tokenizer, source, target,
    pairs: input.pairs.map((p) => ({ id: p.id, status: p.status, source: p.s ? [p.s.start, p.s.end] : null, target: p.t ? [p.t.start, p.t.end] : null,
      linksStatus: input.stats.links.missing.includes(p.id) || input.stats.links.invalid ? "partial" : "ready",
      links: p.status === "matched" ? input.links.filter((l) => l.pairId === p.id).map((l) => ({ source: mappedIds("s", p.id, l.s), target: mappedIds("t", p.id, l.t) })) : [] })) });
  const sync: SyncMap = { version: 2, totalMs: source.narration?.totalMs ?? 0, chunks: input.pairs.flatMap((p) => p.s && p.sTiming.start.ms !== null && p.sTiming.end.ms !== null ? [{ text: input.srcText.slice(p.s.start, p.s.end), startMs: p.sTiming.start.ms, endMs: p.sTiming.end.ms }] : []) };
  const cues: ReaderCues = { format: READER_FORMAT, totalMs: sync.totalMs, granularity: "sentence", text: { format: READER_FORMAT, text: input.srcText },
    cues: input.pairs.flatMap((p, i) => p.s && p.sTiming.start.ms !== null && p.sTiming.end.ms !== null ? [{ range: [p.s.start, p.s.end], t: [p.sTiming.start.ms, p.sTiming.end.ms], s: input.srcText.slice(p.s.start, p.s.end), c: i }] : []) };
  const manifest = { format: READER_FORMAT, book: { id: chapterId, title: input.title, author: null, language: sourceLanguage, medianBodyPt: null, cover: null }, pages: [], sources: [],
    chapters: [{ id: chapterId, i: 0, title: input.title, audio: "../audio/ch000.m4a", cues: "cues/ch000.json", text: null, durationMs: sync.totalMs, pageStart: null, pageEnd: null, mode: "text" as const, why: "generated" as const, bilingual: [{ key, language: targetLanguage, url: `bilingual/${key}.json` }] }] };
  await buildReadaloudEpub({ title: input.title, language: sourceLanguage, chapters: [{ id: chapterId, index: 0, title: input.title, audioPath: path.join(out, `${key}-s.m4a`), sync }], stagingDir: path.join(out, `stage-${key}`), outputPath: path.join(out, `${key}.epub`),
    p2af: async () => ({ manifest, cues: [{ path: "cues/ch000.json", doc: cues }], sources: [], bilingual: [{ path: `bilingual/${key}.json`, doc, audio: [{ path: `audio/${key}.m4a`, sourcePath: path.join(out, `${key}-t.m4a`), mediaType: "audio/mp4" }] }] }) });
  await writeFile(path.join(out, `${key}.json`), JSON.stringify(doc, null, 2));
  console.log(`${key}: ${doc.pairs.length} pairs; ${path.join(out, `${key}.epub`)}`);
}

await exportExample(real, "en-bg", "en", "bg", ["Saved Cartesia Sonic 3.6 narration. Provider timings are not independently verified; zero-duration words do not receive an active-word highlight."]);
const fixtureSchema = z.object({ key: z.string(), from: z.string(), to: z.string(), sourceLocale: z.string(), targetLocale: z.string(), sourceText: z.string(), targetText: z.string(), tokenizer: z.string(), pairs: z.array(z.object({ id: z.string(), s: span, t: span, sTokens: z.array(token), tTokens: z.array(token) })) });
const fixtures = z.array(fixtureSchema).parse(JSON.parse(await readFile(path.join(base, "multilingual/fixtures.json"), "utf8")));
for (const fixture of fixtures) {
  const sAudio = path.join(base, "multilingual", `${fixture.key}-source.wav`), tAudio = path.join(base, "multilingual", `${fixture.key}-target.wav`);
  const sSync = await readSyncMap(sAudio), tSync = await readSyncMap(tAudio);
  if (!sSync || !tSync) throw new Error("Existing recordings missing; no synthesis will be started");
  const sTime = timeline(fixture.sourceText, sSync), tTime = timeline(fixture.targetText, tSync);
  const run = z.object({ links: z.array(link), missing: z.array(z.string()), invalid: z.array(z.unknown()) }).parse(JSON.parse(await readFile(path.join(base, "multilingual", `${fixture.key}-links-1.json`), "utf8")));
  await exportExample({ title: `${fixture.from} / ${fixture.to} — reading sample`, lane: "saved", srcText: fixture.sourceText, tgtText: fixture.targetText, srcAudio: sAudio, tgtAudio: tAudio,
    srcWords: sTime.words, tgtWords: tTime.words, tokenizer: fixture.tokenizer,
    pairs: fixture.pairs.map((p) => ({ ...p, status: "matched", sTiming: spanTiming(sTime, p.s), tTiming: spanTiming(tTime, p.t) })),
    tokens: Object.fromEntries(fixture.pairs.map((p) => [p.id, { s: p.sTokens, t: p.tTokens }])), links: run.links, stats: { links: { missing: run.missing, invalid: run.invalid.length } } },
    fixture.key, fixture.sourceLocale, fixture.targetLocale,
    [fixture.targetLocale === "he" ? "Hebrew provider word times are uniformly spaced; word boundaries have not been verified against speech." : "Provider timings include zero-duration words; these do not receive an active-word highlight."]);
}
