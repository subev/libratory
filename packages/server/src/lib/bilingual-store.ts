import { eq, sql } from "drizzle-orm";
import { db } from "../db.ts";
import { bilingualPreparations, books, chapters, chapterVariants } from "../schema.ts";
import { chapterText } from "./chapter-text.ts";
import { matchesTexts, type BilingualJob, type PairArtifact, type LinkArtifact } from "./bilingual-preparation.ts";

export type PreparationStage = "pairs" | "links";
export const jobColumn = (stage: PreparationStage) => stage === "pairs" ? "pairJob" : "linkJob";

export async function bilingualContext(variantId: string) {
  const [row] = await db.select({ chapter: chapters, variant: chapterVariants, language: books.language })
    .from(chapterVariants).innerJoin(chapters, eq(chapters.id, chapterVariants.chapterId))
    .innerJoin(books, eq(books.id, chapters.bookId)).where(eq(chapterVariants.id, variantId));
  if (!row || row.variant.kind !== "translation" || row.variant.status !== "done") throw new Error("A completed translation is required");
  const source = chapterText(row.chapter).trim(), target = row.variant.text.trim();
  if (!source || !target) throw new Error("Both chapter and translation need text");
  return { ...row, source, target };
}

export async function preparation(variantId: string) {
  const [row] = await db.select().from(bilingualPreparations).where(eq(bilingualPreparations.variantId, variantId));
  return row ?? null;
}

export async function isPreparationRunning(variantId: string, stage: PreparationStage, runId: string): Promise<boolean> {
  const column = bilingualPreparations[jobColumn(stage)];
  const [row] = await db.select({ active: sql<boolean>`${column}->>'runId' = ${runId} AND ${column}->>'status' = 'running'` })
    .from(bilingualPreparations).where(eq(bilingualPreparations.variantId, variantId));
  return row?.active === true;
}

// Lock the text owners before publication: an edit cannot slip between the revision check and save.
export async function publishPreparation(variantId: string, stage: PreparationStage, runId: string,
  captured: { source: string; target: string; pairRevision?: string },
  change: { job: Partial<BilingualJob>; pairs?: PairArtifact; links?: LinkArtifact },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [text] = await tx.select({ chapter: chapters, variant: chapterVariants }).from(chapterVariants)
      .innerJoin(chapters, eq(chapters.id, chapterVariants.chapterId)).where(eq(chapterVariants.id, variantId)).for("update");
    const [row] = await tx.select().from(bilingualPreparations).where(eq(bilingualPreparations.variantId, variantId)).for("update");
    const field = jobColumn(stage), job = row?.[field];
    if (!row || !job || job.runId !== runId || (job.status !== "queued" && job.status !== "running")) return false;
    const stale = !text || text.variant.status !== "done" || chapterText(text.chapter).trim() !== captured.source || text.variant.text.trim() !== captured.target
      || (stage === "links" && row.pairs?.revision !== captured.pairRevision);
    if (stale) {
      await tx.update(bilingualPreparations).set({ [field]: { ...job, status: "failed", error: "Text or sentence pairs changed during preparation. Prepare again.", updatedAt: new Date().toISOString() } }).where(eq(bilingualPreparations.variantId, variantId));
      return false;
    }
    await tx.update(bilingualPreparations).set({
      ...(change.pairs ? { pairs: change.pairs, links: null, linkJob: null } : {}),
      ...(change.links ? { links: change.links } : {}),
      [field]: { ...job, ...change.job, updatedAt: new Date().toISOString() }, updatedAt: new Date(),
    }).where(eq(bilingualPreparations.variantId, variantId));
    return true;
  });
}

export async function currentPreparation(variantId: string) {
  const context = await bilingualContext(variantId), row = await preparation(variantId);
  return { context, row, current: matchesTexts(row?.pairs ?? null, context.source, context.target) };
}

export async function failPreparation(variantId: string, stage: PreparationStage, runId: string, error: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(bilingualPreparations).where(eq(bilingualPreparations.variantId, variantId)).for("update");
    const field = jobColumn(stage), job = row?.[field];
    if (!job || job.runId !== runId || (job.status !== "queued" && job.status !== "running")) return;
    await tx.update(bilingualPreparations).set({ [field]: { ...job, status: "failed", error, updatedAt: new Date().toISOString() } })
      .where(eq(bilingualPreparations.variantId, variantId));
  });
}
