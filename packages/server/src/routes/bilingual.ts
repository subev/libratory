import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { quickAddJob } from "graphile-worker";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { bilingualPreparations, chapterVariants } from "../schema.ts";
import { publicProcedure, router } from "../trpc.ts";
import { bilingualContext, currentPreparation, jobColumn, failPreparation } from "../lib/bilingual-store.ts";
import { matchesTexts, type BilingualJob } from "../lib/bilingual-preparation.ts";
import { bundleInstalled } from "../lib/model-bundles.ts";
import { textRevision, switchNarration } from "../lib/bilingual-format.ts";
import { buildBilingualDocument } from "../lib/bilingual-document.ts";
import { linkBatches, linkPrompt, wordLinkSystem } from "../lib/bilingual-links.ts";
import { modelKeySchema, resolveLlm } from "../lib/llm.ts";

const choice = z.object({ variantId: z.string().uuid(), stage: z.enum(["pairs", "links"]) });
const busy = (job: BilingualJob | null) => job && (job.status === "queued" || job.status === "running") && Date.now() - Date.parse(job.updatedAt) < 15 * 60_000;

export const bilingualRouter = router({
  status: publicProcedure.input(z.object({ chapterId: z.string().uuid(), key: z.string() })).query(async ({ input }) => {
    const [variant] = await db.select().from(chapterVariants).where(and(eq(chapterVariants.chapterId, input.chapterId), eq(chapterVariants.key, input.key)));
    if (!variant || variant.kind !== "translation" || variant.status !== "done" || !variant.text.trim()) return { variantId: null, current: false, pairs: 0, linked: 0, pairJob: null, linkJob: null, busy: false, estimatedInputTokens: 0, batches: 0, matched: 0, linkError: null };
    const { context, row, current } = await currentPreparation(variant.id);
    const linked = current && row?.links && row.links.pairRevision === row.pairs?.revision ? Object.keys(row.links.byPair).length : 0;
    const artifact = current ? row?.pairs : null;
    let batches: ReturnType<typeof linkBatches> = [], linkError: string | null = null;
    try { if (artifact) batches = linkBatches(artifact, row?.links?.pairRevision === artifact.revision ? row.links.byPair : {}); }
    catch (error) { linkError = error instanceof Error ? error.message : String(error); }
    const estimatedInputTokens = artifact ? Math.ceil(batches.reduce((sum, batch) => sum + linkPrompt(artifact, batch).length + wordLinkSystem(context.language ?? "und", variant.key).length, 0) / 2) : 0;
    const visible = (job: BilingualJob | null) => job && !busy(job) && (job.status === "running" || job.status === "queued")
      ? { ...job, status: "failed" as const, error: "Preparation was interrupted. Retry explicitly to continue." } : job;
    return { variantId: variant.id, current, pairs: current ? row?.pairs?.pairs.length ?? 0 : 0, linked,
      pairJob: visible(row?.pairJob ?? null), linkJob: visible(row?.linkJob ?? null), busy: !!(busy(row?.pairJob ?? null) || busy(row?.linkJob ?? null)),
      estimatedInputTokens, linkError, batches: batches.length, matched: current ? row?.pairs?.pairs.filter((p) => p.status === "matched").length ?? 0 : 0 };
  }),
  position: publicProcedure.input(z.object({ variantId: z.string().uuid(), ms: z.number().nonnegative() })).query(async ({ input }) => {
    const doc = await buildBilingualDocument(input.variantId);
    return { ms: doc ? switchNarration(doc, "target", input.ms)?.ms ?? 0 : 0 };
  }),
  prepare: publicProcedure.input(choice.extend({ model: modelKeySchema.optional() })).mutation(async ({ input }) => {
    const context = await bilingualContext(input.variantId);
    if (input.stage === "pairs" && !(await bundleInstalled("search"))) throw new Error("Install the optional search model bundle first");
    const model = input.stage === "links" ? (await resolveLlm(input.model)).def.key : null;
    const runId = randomUUID(), field = jobColumn(input.stage);
    await db.transaction(async (tx) => {
      await tx.insert(bilingualPreparations).values({ variantId: input.variantId }).onConflictDoNothing();
      const [row] = await tx.select().from(bilingualPreparations).where(eq(bilingualPreparations.variantId, input.variantId)).for("update");
      if (!row) throw new Error("Preparation disappeared");
      if (busy(row.pairJob) || busy(row.linkJob)) throw new Error("Preparation is already running");
      if (input.stage === "links" && !matchesTexts(row.pairs, context.source, context.target)) throw new Error("Prepare current sentence pairs first");
      const job: BilingualJob = { status: "queued", runId, model, done: 0, total: 0, error: null, updatedAt: new Date().toISOString() };
      await tx.update(bilingualPreparations).set({ [field]: job }).where(eq(bilingualPreparations.variantId, input.variantId));
    });
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
  }),
  cancel: publicProcedure.input(choice).mutation(async ({ input }) => {
    const field = jobColumn(input.stage);
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(bilingualPreparations).where(eq(bilingualPreparations.variantId, input.variantId)).for("update");
      const job = row?.[field];
      if (!job || (job.status !== "queued" && job.status !== "running")) return;
      await tx.update(bilingualPreparations).set({ [field]: { ...job, status: "cancelled", updatedAt: new Date().toISOString() } }).where(eq(bilingualPreparations.variantId, input.variantId));
    });
  }),
});
