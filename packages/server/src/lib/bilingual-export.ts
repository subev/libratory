import path from "node:path";
import { stat } from "node:fs/promises";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.ts";
import { chapters, chapterVariants, bilingualPreparations, type Book } from "../schema.ts";
import { bilingualReferencesForBook, buildBilingualDocument } from "./bilingual-document.ts";
import { buildTextP2afLayer, type P2afLayer } from "./p2af.ts";
import { buildVariantCues } from "./reader-doc.ts";
import { chapterText } from "./chapter-text.ts";
import { readSyncMap } from "./sync-map.ts";

export const bilingualExportSchema = z.object({
  sourceAudio: z.boolean(),
  targetAudio: z.boolean(),
});
export type BilingualExportOptions = z.infer<typeof bilingualExportSchema>;

async function selectedRows(bookId: string, key: string) {
  return db.select({ chapter: chapters, variant: chapterVariants, preparation: bilingualPreparations }).from(chapters)
    .leftJoin(chapterVariants, and(eq(chapterVariants.chapterId, chapters.id), eq(chapterVariants.key, key)))
    .leftJoin(bilingualPreparations, eq(bilingualPreparations.variantId, chapterVariants.id))
    .where(and(eq(chapters.bookId, bookId), eq(chapters.selected, true))).orderBy(asc(chapters.index));
}

async function audioStatus(file: string | null) {
  const exists = file ? await stat(file).then((info) => info.isFile(), () => false) : false;
  const sync = file && exists ? await readSyncMap(file) : null;
  return { available: !!sync && sync.totalMs > 0,
    words: !!sync?.chunks.some((chunk) => chunk.words?.some((word) => word.endMs > word.startMs)),
    legacy: !!file && path.extname(file).toLowerCase() === ".mp3" };
}

export async function bilingualExportStatus(bookId: string, key: string) {
  const [rows, refs] = await Promise.all([selectedRows(bookId, key), bilingualReferencesForBook(bookId)]);
  const prepared = new Set(refs.filter((ref) => ref.key === key).map((ref) => ref.chapterId));
  return Promise.all(rows.map(async ({ chapter, variant, preparation }) => ({
    id: chapter.id, index: chapter.index, title: chapter.title, paired: prepared.has(chapter.id),
    matchedGroups: prepared.has(chapter.id) ? preparation?.pairs?.pairs.filter((pair) => pair.status === "matched").length ?? 0 : 0,
    linkedGroups: prepared.has(chapter.id) && preparation?.links?.pairRevision === preparation?.pairs?.revision
      ? Object.values(preparation?.links?.byPair ?? {}).filter((links) => links.length > 0).length : 0,
    source: await audioStatus(chapter.status === "done" ? chapter.audioPath : null),
    target: await audioStatus(variant?.audioStatus === "done" ? variant.audioPath : null),
  })));
}

// What the assistant and the tray need before offering an export: which selected chapters of each
// translation are paired against their current text, and which still need it. Database only —
// no sync maps are read, so it is cheap enough to ride along with every get_book.
export async function bilingualReadiness(bookId: string) {
  const [keys, refs] = await Promise.all([
    db.selectDistinct({ key: chapterVariants.key }).from(chapterVariants)
      .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
      .where(and(eq(chapters.bookId, bookId), eq(chapterVariants.kind, "translation"))),
    bilingualReferencesForBook(bookId),
  ]);
  return Promise.all(keys.map(async ({ key }) => {
    const rows = await selectedRows(bookId, key);
    const prepared = new Set(refs.filter((ref) => ref.key === key).map((ref) => ref.chapterId));
    const paired = rows.filter(({ chapter }) => prepared.has(chapter.id));
    const linked = paired.filter(({ preparation }) => {
      const matched = preparation?.pairs?.pairs.filter((pair) => pair.status === "matched").length ?? 0;
      const links = preparation?.links?.pairRevision === preparation?.pairs?.revision
        ? Object.values(preparation?.links?.byPair ?? {}).filter((entry) => entry.length > 0).length : 0;
      return matched > 0 && links >= matched;
    });
    return {
      key, language: refs.find((ref) => ref.key === key)?.language ?? key,
      selected: rows.length, paired: paired.length, linked: linked.length,
      untranslated: rows.filter(({ variant }) => !variant || variant.status !== "done").map(({ chapter }) => ({ index: chapter.index, title: chapter.title })),
      unpaired: rows.filter(({ chapter, variant }) => variant?.status === "done" && !prepared.has(chapter.id)).map(({ chapter }) => ({ index: chapter.index, title: chapter.title })),
    };
  }));
}

export function namedChapters(rows: { index: number; title: string }[]): string {
  const names = rows.slice(0, 3).map((row) => `${row.index + 1}. ${row.title}`);
  return rows.length > 3 ? `${names.join(", ")} and ${rows.length - 3} more` : names.join(", ");
}

export async function buildBilingualExportLayer(book: Book, key: string, options: BilingualExportOptions) {
  const rows = await selectedRows(book.id, key);
  if (!rows.length) throw new Error("Select chapters to export");
  const exported = rows.map(({ chapter }) => ({ id: chapter.id, index: chapter.index,
    title: chapter.title, text: chapterText(chapter).trim() }));
  const layer = await buildTextP2afLayer(book, exported);
  for (const { chapter, variant } of rows) {
    if (!variant || variant.kind !== "translation" || variant.status !== "done") {
      throw new Error(`Finish the ${key} translation for ${chapter.title} before exporting`);
    }
    const sourcePath = chapter.status === "done" ? chapter.audioPath : null;
    const targetPath = variant.audioStatus === "done" ? variant.audioPath : null;
    const sourceURL = `audio/source-${chapter.id}${path.extname(sourcePath ?? "audio.m4a")}`;
    const targetURL = `audio/target-${variant.id}${path.extname(targetPath ?? "audio.m4a")}`;
    const doc = await buildBilingualDocument(variant.id, {
      source: sourceURL, target: targetURL, sourceAudio: options.sourceAudio, targetAudio: options.targetAudio, textOnly: !options.sourceAudio && !options.targetAudio,
    });
    if (!doc || doc.source.text !== chapterText(chapter).trim()) {
      throw new Error(`Pair current sentences for ${chapter.title} before exporting`);
    }
    if (!options.sourceAudio) doc.source.narration = null;
    if (!options.targetAudio) doc.target.narration = null;
    const entry = layer.manifest.chapters.find((entry) => entry.id === chapter.id);
    if (!entry) throw new Error("Missing exported chapter");
    const audio: NonNullable<P2afLayer["bilingual"]>[number]["audio"] = [];
    for (const [lane, file] of [[doc.source, sourcePath], [doc.target, targetPath]] as const) {
      if (!lane.narration || !file) continue;
      audio.push({ path: lane.narration.audio, sourcePath: file,
        mediaType: path.extname(file).toLowerCase() === ".m4a" ? "audio/mp4" : "audio/mpeg" });
    }
    if (doc.source.narration) {
      const cues = sourcePath ? await buildVariantCues(sourcePath, doc.source.text) : null;
      if (!cues || cues.text?.text !== doc.source.text) throw new Error(`Original timing changed for ${chapter.title}`);
      entry.audio = sourceURL;
      entry.cues = `cues/${chapter.id}.json`;
      entry.durationMs = doc.source.narration.totalMs;
      layer.cues.push({ path: entry.cues, doc: cues });
    }
    const resource = `bilingual/${variant.id}.json`;
    layer.bilingual?.push({ path: resource, doc, audio });
    entry.bilingual = [{ key, language: doc.target.language, url: resource }];
  }
  return { layer, chapters: exported };
}
