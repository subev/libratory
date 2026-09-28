import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { quickAddJob } from "graphile-worker";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { bilingualPreparations, chapterVariants, chapters, books } from "../schema.ts";
import { publicProcedure, router } from "../trpc.ts";
import { bilingualContext, currentPreparation, jobColumn, failPreparation } from "../lib/bilingual-store.ts";
import { matchesTexts, type BilingualJob } from "../lib/bilingual-preparation.ts";
import { bundleInstalled } from "../lib/model-bundles.ts";
import { textRevision, switchNarration } from "../lib/bilingual-format.ts";
import { convertLegacyBilingualAudio, isLegacyAudio } from "../lib/bilingual-audio.ts";
import { buildBilingualDocument } from "../lib/bilingual-document.ts";
import { linkBatches, linkPrompt, wordLinkSystem } from "../lib/bilingual-links.ts";
import { chapterText } from "../lib/chapter-text.ts";
import { modelKeySchema, resolveLlm } from "../lib/llm.ts";

const choice = z.object({ variantId: z.string().uuid(), stage: z.enum(["pairs", "links"]) });
// Queue age is not a failure signal; workers and the startup sweep persist terminal states.
const busy = (job: BilingualJob | null) => job?.status === "queued" || job?.status === "running";

function summarize(context: Awaited<ReturnType<typeof bilingualContext>>, row: Awaited<ReturnType<typeof currentPreparation>>["row"], current: boolean) {
  const variant = context.variant;
  const linked = current && row?.links && row.links.pairRevision === row.pairs?.revision ? Object.keys(row.links.byPair).length : 0;
  const artifact = current ? row?.pairs : null;
  let batches: ReturnType<typeof linkBatches> = [], linkError: string | null = null;
  try { if (artifact) batches = linkBatches(artifact, row?.links?.pairRevision === artifact.revision ? row.links.byPair : {}); }
  catch (error) { linkError = error instanceof Error ? error.message : String(error); }
  const estimatedInputTokens = artifact ? Math.ceil(batches.reduce((sum, batch) => sum + linkPrompt(artifact, batch).length + wordLinkSystem(context.language ?? "und", variant.key).length, 0) / 2) : 0;
  return { variantId: variant.id, legacyAudio: isLegacyAudio(context.chapter.audioPath) || isLegacyAudio(variant.audioPath), current, pairs: current ? row?.pairs?.pairs.length ?? 0 : 0, linked,
    pairJob: row?.pairJob ?? null, linkJob: row?.linkJob ?? null, busy: busy(row?.pairJob ?? null) || busy(row?.linkJob ?? null),
    estimatedInputTokens, linkError, batches: batches.length, matched: current ? row?.pairs?.pairs.filter((p) => p.status === "matched").length ?? 0 : 0 };
}

async function queuePreparation(input: z.infer<typeof choice> & { model?: string }, onlyMissing = false) {
  const context = await bilingualContext(input.variantId);
  if (input.stage === "pairs" && !(await bundleInstalled("search"))) throw new Error("Install the optional search model bundle first");
  const model = input.stage === "links" ? (await resolveLlm(input.model)).def.key : null;
  const runId = randomUUID(), field = jobColumn(input.stage);
  const queued = await db.transaction(async (tx) => {
    await tx.insert(bilingualPreparations).values({ variantId: input.variantId }).onConflictDoNothing();
    const [row] = await tx.select().from(bilingualPreparations).where(eq(bilingualPreparations.variantId, input.variantId)).for("update");
    if (!row) throw new Error("Preparation disappeared");
    if (busy(row.pairJob) || busy(row.linkJob)) throw new Error("Preparation is already running");
    if (input.stage === "links" && !matchesTexts(row.pairs, context.source, context.target)) throw new Error("Prepare current sentence pairs first");
    if (onlyMissing && row.pairs && (input.stage === "pairs"
      ? matchesTexts(row.pairs, context.source, context.target)
      : linkBatches(row.pairs, row.links?.pairRevision === row.pairs.revision ? row.links.byPair : {}).length === 0)) return false;
    const job: BilingualJob = { status: "queued", runId, model, done: 0, total: 0, error: null, updatedAt: new Date().toISOString() };
    await tx.update(bilingualPreparations).set({ [field]: job }).where(eq(bilingualPreparations.variantId, input.variantId));
    return true;
  });
  if (!queued) return { runId: null };
  try {
    await quickAddJob({ connectionString: env.DATABASE_URL }, input.stage === "pairs" ? "alignBilingual" : "linkBilingual", {
      variantId: input.variantId, bookId: context.chapter.bookId, runId, stage: input.stage,
      sourceRevision: textRevision(context.source), targetRevision: textRevision(context.target),
    }, { maxAttempts: 1, jobKey: `bilingual:${input.stage}:${input.variantId}:${runId}` });
  } catch (error) {
    await failPreparation(input.variantId, input.stage, runId, "Could not queue preparation. Retry explicitly.");
    throw error;
  }
  return { runId };
}

async function cancelPreparation(input: z.infer<typeof choice>) {
  const field = jobColumn(input.stage);
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(bilingualPreparations).where(eq(bilingualPreparations.variantId, input.variantId)).for("update");
    const job = row?.[field];
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    await tx.update(bilingualPreparations).set({ [field]: { ...job, status: "cancelled", updatedAt: new Date().toISOString() } }).where(eq(bilingualPreparations.variantId, input.variantId));
  });
}

const selection = z.object({ bookId: z.string().uuid(), chapterIds: z.array(z.string().uuid()).min(1).max(1000), key: z.string().min(1) });
async function selectedPreparation(input: z.infer<typeof selection>) {
  const ids = [...new Set(input.chapterIds)];
  const rows = await db.select({ chapter: chapters, language: books.language, variant: chapterVariants, row: bilingualPreparations })
    .from(chapters).innerJoin(books, eq(books.id, chapters.bookId))
    .leftJoin(chapterVariants, and(eq(chapterVariants.chapterId, chapters.id), eq(chapterVariants.key, input.key)))
    .leftJoin(bilingualPreparations, eq(bilingualPreparations.variantId, chapterVariants.id))
    .where(and(eq(chapters.bookId, input.bookId), inArray(chapters.id, ids))).orderBy(asc(chapters.index));
  if (rows.length !== ids.length) throw new Error("Selection contains missing chapters or chapters from another book");
  return rows.map(({ chapter, variant, row, language }) => {
    const source = chapterText(chapter).trim(), target = variant?.text.trim() ?? "";
    const available = variant?.kind === "translation" && variant.status === "done" && !!source && !!target;
    const status = variant?.kind === "translation"
      ? summarize({ chapter, variant, language, source, target }, row, available && matchesTexts(row?.pairs ?? null, source, target)) : null;
    return { chapterId: chapter.id, index: chapter.index, title: chapter.title, available, status };
  });
}

export const bilingualRouter = router({
  selection: publicProcedure.input(selection).query(({ input }) => selectedPreparation(input)),
  prepareSelection: publicProcedure.input(selection.extend({ stage: z.enum(["pairs", "links"]), model: modelKeySchema.optional() })).mutation(async ({ input }) => {
    const rows = await selectedPreparation(input);
    const results: { chapterId: string; queued: boolean; error: string | null }[] = [];
    for (const row of rows) {
      const status = row.status;
      if (!row.available || !status || status.busy || (input.stage === "pairs" ? status.current : !status.current || status.batches === 0 || status.linkError)) continue;
      try {
        const job = await queuePreparation({ variantId: status.variantId, stage: input.stage, model: input.model }, true);
        results.push({ chapterId: row.chapterId, queued: job.runId !== null, error: null });
      } catch (error) {
        results.push({ chapterId: row.chapterId, queued: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }),
  cancelSelection: publicProcedure.input(selection).mutation(async ({ input }) => {
    for (const row of await selectedPreparation(input)) {
      if (!row.status) continue;
      for (const stage of ["pairs", "links"] as const) {
        await cancelPreparation({ variantId: row.status.variantId, stage });
      }
    }
    return { success: true };
  }),

  status: publicProcedure.input(z.object({ chapterId: z.string().uuid(), key: z.string() })).query(async ({ input }) => {
    const [variant] = await db.select().from(chapterVariants).where(and(eq(chapterVariants.chapterId, input.chapterId), eq(chapterVariants.key, input.key)));
    if (!variant || variant.kind !== "translation" || variant.status !== "done" || !variant.text.trim()) return { variantId: null, legacyAudio: false, current: false, pairs: 0, linked: 0, pairJob: null, linkJob: null, busy: false, estimatedInputTokens: 0, batches: 0, matched: 0, linkError: null };
    const { context, row, current } = await currentPreparation(variant.id);
    return summarize(context, row, current);
  }),
  convertAudio: publicProcedure.input(z.object({ variantId: z.string().uuid() })).mutation(({ input }) => convertLegacyBilingualAudio(input.variantId)),
  position: publicProcedure.input(z.object({ variantId: z.string().uuid(), ms: z.number().nonnegative() })).query(async ({ input }) => {
    const doc = await buildBilingualDocument(input.variantId);
    return { ms: doc ? switchNarration(doc, "target", input.ms)?.ms ?? 0 : 0 };
  }),
  prepare: publicProcedure.input(choice.extend({ model: modelKeySchema.optional() })).mutation(async ({ input }) => {
    return queuePreparation(input);
  }),
  cancel: publicProcedure.input(choice).mutation(async ({ input }) => {
    return cancelPreparation(input);
  }),
});
