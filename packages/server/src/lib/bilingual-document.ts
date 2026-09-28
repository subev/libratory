import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.ts";
import { bilingualPreparations, chapters, chapterVariants } from "../schema.ts";
import { preparedPairs } from "./bilingual-preparation.ts";
import { currentPreparation } from "./bilingual-store.ts";
import { BILINGUAL_FORMAT, readBilingualDocument, textRevision, type BilingualDocument, type BilingualLane, type BilingualPair } from "./bilingual-format.ts";
import { readSyncMap, syncMapPath } from "./sync-map.ts";
import { timeline, spanTiming } from "./bilingual-timing.ts";

export async function bilingualReferencesForBook(bookId: string) {
  const rows = await db.select({
    chapterId: chapters.id, variantId: chapterVariants.id, key: chapterVariants.key,
    source: sql<string>`coalesce(${chapters.customText}, ${chapters.cleanText}, ${chapters.rawText}, '')`,
    target: chapterVariants.text,
    sourceRevision: sql<string | null>`${bilingualPreparations.pairs}->'source'->>'textRevision'`,
    targetRevision: sql<string | null>`${bilingualPreparations.pairs}->'target'->>'textRevision'`,
    language: sql<string | null>`${bilingualPreparations.pairs}->'target'->>'language'`,
  }).from(bilingualPreparations)
    .innerJoin(chapterVariants, eq(chapterVariants.id, bilingualPreparations.variantId))
    .innerJoin(chapters, eq(chapters.id, chapterVariants.chapterId))
    .where(and(eq(chapters.bookId, bookId), eq(chapterVariants.kind, "translation"), eq(chapterVariants.status, "done")));
  return rows.filter((row) => row.sourceRevision === textRevision(row.source.trim()) && row.targetRevision === textRevision(row.target.trim()))
    .map((row) => ({ chapterId: row.chapterId, variantId: row.variantId, key: row.key,
      language: row.language ?? row.key, url: `/read/bilingual/${row.variantId}.json` }));
}

async function narration(text: string, pairs: BilingualPair[], side: "source" | "target", audioPath: string | null, url: string): Promise<BilingualLane["narration"]> {
  if (!audioPath) return null;
  try {
    const before = await stat(audioPath), beforeSync = await stat(syncMapPath(audioPath));
    const map = await readSyncMap(audioPath);
    if (!map || map.totalMs <= 0) return null;
    const tl = timeline(text, map);
    if (tl.chunks.length !== map.chunks.length) return null;
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(audioPath)) hash.update(bytes);
    const after = await stat(audioPath), afterSync = await stat(syncMapPath(audioPath));
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || beforeSync.mtimeMs !== afterSync.mtimeMs || beforeSync.size !== afterSync.size) throw new Error("Narration changed while reading timing");
    const boundaries = new Set([text.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.index)]);
    return { revision: hash.digest("hex"), audio: url, totalMs: map.totalMs,
      qualityNotes: ["Provider word times are not independently verified. Passages without word times use chunk boundaries or estimates."],
      anchors: [
        ...pairs.flatMap((pair) => {
          const range = pair[side];
          return range ? [{ range, kind: "passage" as const, ...spanTiming(tl, { start: range[0], end: range[1] }) }] : [];
        }),
        ...tl.words.filter((w) => boundaries.has(w.start) && boundaries.has(w.end)).map((word) => ({
          range: [word.start, word.end] as [number, number], kind: "word" as const,
          start: { ms: word.startMs, method: "provider-word" as const }, end: { ms: word.endMs, method: "provider-word" as const },
        })),
      ] };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function buildBilingualDocument(variantId: string, urls?: { source: string; target: string }): Promise<BilingualDocument | null> {
  const { context, row, current } = await currentPreparation(variantId);
  if (!current || !row?.pairs) return null;
  const data = row.pairs, pairs = preparedPairs(data, row.links);
  const [source, target] = await Promise.all([
    narration(context.source, pairs, "source", context.chapter.status === "done" ? context.chapter.audioPath : null, urls?.source ?? `/audio/chapter/${context.chapter.id}`),
    narration(context.target, pairs, "target", context.variant.audioStatus === "done" ? context.variant.audioPath : null, urls?.target ?? `/audio/translation/${variantId}`),
  ]);
  const latest = await currentPreparation(variantId);
  if (latest.context.chapter.status !== context.chapter.status || latest.context.variant.audioStatus !== context.variant.audioStatus
    || latest.context.variant.updatedAt.getTime() !== context.variant.updatedAt.getTime()
    || !latest.current || latest.row?.pairs?.revision !== data.revision || latest.context.chapter.audioPath !== context.chapter.audioPath || latest.context.variant.audioPath !== context.variant.audioPath) return null;
  return readBilingualDocument({ format: BILINGUAL_FORMAT, chapterId: context.chapter.id, key: context.variant.key, tokenizer: data.tokenizer,
    source: { ...data.source, narration: source }, target: { ...data.target, narration: target }, pairs });
}
