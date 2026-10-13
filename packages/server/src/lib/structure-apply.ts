import { and, eq, inArray } from "drizzle-orm";
import { rename, rm } from "node:fs/promises";
import path from "node:path";

import { db } from "../db.ts";
import { chapters, chapterVariants } from "../schema.ts";
import { chapterChunkPreviewDir } from "./chunk-previews.ts";
import { appendLog } from "./log.ts";
import { syncMapPath } from "./sync-map.ts";
import type { StructurePlan } from "./structure-plan.ts";
import { translationChunkPreviewDir } from "../workers/synthesize-translation.ts";

export type Move = { from: string; to: string };

export type StagedMoves = {
  /** Undo every move; throws if a file could not be put back, naming it. */
  rollback(): Promise<void>;
};

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

// Every source steps aside under a per-move name before any destination is written, so a set of
// moves can be a cycle (two chapters swapping places). Undo is the same dance backwards.
async function shuffle(moves: { source: string; target: string }[], tag: string): Promise<void> {
  const aside: { aside: string; source: string; target: string }[] = [];
  const settled = new Set<string>();
  try {
    for (const [i, move] of moves.entries()) {
      const name = `${move.source}.${tag}-${i}`;
      try {
        await rename(move.source, name);
      } catch (err) {
        if (missing(err)) continue;
        throw err;
      }
      aside.push({ aside: name, source: move.source, target: move.target });
    }
    for (const move of aside) {
      // Whatever sits at the destination belongs to no current chapter: theirs are staged or gone
      await rm(move.target, { recursive: true, force: true });
      await rename(move.aside, move.target);
      settled.add(move.target);
    }
  } catch (err) {
    // Put every staged file back under its own name: first aside again (a settled destination may
    // be another move's source), then home
    const trouble: string[] = [];
    const back: { aside: string; source: string }[] = [];
    for (const [i, move] of aside.entries()) {
      const at = settled.has(move.target) ? move.target : move.aside;
      const name = `${move.source}.${tag}-back-${i}`;
      await rename(at, name).then(() => back.push({ aside: name, source: move.source })).catch(() => trouble.push(move.source));
    }
    for (const move of back) await rename(move.aside, move.source).catch(() => trouble.push(move.source));
    const suffix = trouble.length ? ` (and could not restore: ${trouble.join(", ")})` : "";
    throw new Error(`Could not move chapter files: ${err instanceof Error ? err.message : String(err)}${suffix}`, { cause: err });
  }
}

// Chapter files are named by index (ch003.m4a, chunks/ch003), so a kept chapter that lands on a new
// index has to carry its files with it, or the next synthesis at its old index writes over them.
// A removed chapter's files move to a `.removed` name in the same pass, so that until the caller
// commits, every file is still on disk and the whole pass can be undone. A missing source is a
// chapter whose audio was already cleaned up and is skipped; any other failure undoes the pass.
export async function moveAll(moves: Move[]): Promise<StagedMoves> {
  const real = moves.filter((m) => m.from !== m.to).map((m) => ({ source: m.from, target: m.to }));
  await shuffle(real, "moving");
  return {
    rollback: () => shuffle(real.map((m) => ({ source: m.target, target: m.source })), "restoring"),
  };
}

function indexed(audioPath: string, index: number): string {
  return path.join(path.dirname(audioPath), `ch${String(index).padStart(3, "0")}${path.extname(audioPath)}`);
}

const removedName = (file: string) => `${file}.removed`;

export type ApplyOutcome = { kept: number; fresh: number; removed: number; removedAudio: number };

// Executes a plan. Order is what makes a failure survivable: every file move first (undone on
// failure), then the rows in one transaction (files undone if it fails), and only then are the
// removed chapters' files actually deleted. Nothing here runs OCR or synthesis.
export async function applyStructurePlan(bookId: string, plan: StructurePlan): Promise<ApplyOutcome> {
  const removedIds = plan.removed.map((c) => c.id);
  const keptIds = plan.order.flatMap((p) => (p.kind === "kept" ? [p.chapter.id] : []));
  const touched = [...removedIds, ...keptIds];
  const variants = touched.length
    ? await db
        .select({ id: chapterVariants.id, chapterId: chapterVariants.chapterId, key: chapterVariants.key, audioPath: chapterVariants.audioPath })
        .from(chapterVariants)
        .where(inArray(chapterVariants.chapterId, touched))
    : [];

  const moves: Move[] = [];
  const trash: string[] = [];
  const retire = (file: string) => {
    moves.push({ from: file, to: removedName(file) });
    trash.push(removedName(file));
  };
  for (const old of plan.removed) {
    if (old.audioPath) {
      retire(old.audioPath);
      retire(syncMapPath(old.audioPath));
    }
    retire(chapterChunkPreviewDir(bookId, old.index));
    for (const v of variants.filter((v) => v.chapterId === old.id)) {
      if (v.audioPath) {
        retire(v.audioPath);
        retire(syncMapPath(v.audioPath));
      }
      retire(translationChunkPreviewDir(bookId, v.key, old.index));
    }
  }

  const audioUpdates: { table: "chapter" | "variant"; id: string; audioPath: string }[] = [];
  for (const [index, planned] of plan.order.entries()) {
    if (planned.kind !== "kept" || planned.chapter.index === index) continue;
    const old = planned.chapter;
    if (old.audioPath) {
      const next = indexed(old.audioPath, index);
      moves.push({ from: old.audioPath, to: next }, { from: syncMapPath(old.audioPath), to: syncMapPath(next) });
      audioUpdates.push({ table: "chapter", id: old.id, audioPath: next });
    }
    moves.push({ from: chapterChunkPreviewDir(bookId, old.index), to: chapterChunkPreviewDir(bookId, index) });
    for (const v of variants.filter((v) => v.chapterId === old.id)) {
      if (v.audioPath) {
        const next = indexed(v.audioPath, index);
        moves.push({ from: v.audioPath, to: next }, { from: syncMapPath(v.audioPath), to: syncMapPath(next) });
        audioUpdates.push({ table: "variant", id: v.id, audioPath: next });
      }
      moves.push({ from: translationChunkPreviewDir(bookId, v.key, old.index), to: translationChunkPreviewDir(bookId, v.key, index) });
    }
  }

  const staged = await moveAll(moves);

  let kept = 0;
  let fresh = 0;
  const logs: string[] = [];
  try {
    await db.transaction(async (tx) => {
      if (removedIds.length > 0) {
        await tx.delete(chapters).where(and(eq(chapters.bookId, bookId), inArray(chapters.id, removedIds)));
      }
      for (const u of audioUpdates) {
        if (u.table === "chapter") await tx.update(chapters).set({ audioPath: u.audioPath }).where(eq(chapters.id, u.id));
        else await tx.update(chapterVariants).set({ audioPath: u.audioPath }).where(eq(chapterVariants.id, u.id));
      }
      for (const [index, planned] of plan.order.entries()) {
        if (planned.kind === "kept") {
          kept++;
          await tx.update(chapters).set({ index, title: planned.title }).where(eq(chapters.id, planned.chapter.id));
          continue;
        }
        fresh++;
        const ch = planned.chapter;
        await tx.insert(chapters).values({
          bookId,
          index,
          title: ch.title,
          rawText: ch.text,
          customText: planned.customText,
          pageStart: ch.pageStart,
          pageEnd: ch.pageEnd,
          sourceBlocks: ch.sourceBlocks,
          sourceFileIndex: ch.fileIndex,
          status: "suspended",
        });
        const words = ch.text.split(/\s+/).filter(Boolean).length;
        logs.push(`Chapter ${index + 1}: "${ch.title}" (${words.toLocaleString()} words, new)`);
      }
    });
  } catch (err) {
    await staged.rollback();
    throw err;
  }

  for (const message of logs) await appendLog(bookId, message);
  for (const file of trash) await rm(file, { recursive: true, force: true }).catch(() => {});

  return { kept, fresh, removed: plan.removed.length, removedAudio: plan.removed.filter((c) => c.audioPath).length };
}

// The extraction-derived chapters of a book, with what a plan needs to know about each
export async function loadExistingChapters(bookId: string) {
  return db
    .select({
      id: chapters.id,
      index: chapters.index,
      title: chapters.title,
      customText: chapters.customText,
      audioPath: chapters.audioPath,
      durationMs: chapters.durationMs,
      pageStart: chapters.pageStart,
      pageEnd: chapters.pageEnd,
      sourceBlocks: chapters.sourceBlocks,
      sourceFileIndex: chapters.sourceFileIndex,
      source: chapters.source,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId));
}
