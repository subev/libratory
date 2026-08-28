import { z } from "zod";
import { modelKeySchema } from "../lib/llm.ts";
import { router, publicProcedure } from "../trpc.ts";
import { db } from "../db.ts";
import { books, chapters, chapterVariants, type VariantParams } from "../schema.ts";
import { parseTtsVoice } from "../lib/tts.ts";
import { eq, and, inArray, sql, asc } from "drizzle-orm";
import { quickAddJob } from "graphile-worker";
import { appendLog } from "../lib/log.ts";
import { env } from "../env.ts";
import { listChunkPreviewsIn, locateChunks, pageAtOffset, syncMapChunkPreviews, audioCacheKey } from "../lib/chunk-previews.ts";
import { languageSlug, translationChunkPreviewDir } from "../workers/synthesize-translation.ts";
import { getTransformPreset, TRANSFORM_PRESETS } from "../lib/transform-presets.ts";
import { inferVariantLabel, variantKeySlug, variantLabel } from "../lib/transform.ts";
import { dirSize } from "../lib/disk-usage.ts";
import { assembleJobKey, inFlightInputs } from "../lib/output-readiness.ts";
import { stat, unlink, rm } from "node:fs/promises";
import type { SourceBlock } from "../lib/marker.ts";

const connectionString = env.DATABASE_URL;

const STALE_RUNNING_MS = 15 * 60_000;

// Requeueing without this leaves the old job behind and two workers end up
// interleaving writes on the same variant row.
async function deleteQueuedTranslateJobs(variantIds: string[]) {
  if (variantIds.length === 0) return;
  await db.execute(sql`
    DELETE FROM graphile_worker._private_jobs j
    USING graphile_worker._private_tasks t
    WHERE t.id = j.task_id AND t.identifier = 'translate'
      AND (j.payload ->> 'translationId') IN (SELECT json_array_elements_text(${JSON.stringify(variantIds)}::json))
      AND j.locked_at IS NULL
  `);
}

type VariantSpec = {
  kind: "translation" | "transform";
  label: string | null;
  prompt: string | null;
  params: VariantParams | null;
};

// A key with no existing rows resolves to: a preset spec, a fresh translation
// lane (keys from the language dropdown), or an error for orphaned customs.
async function resolveSpec(bookId: string, key: string): Promise<VariantSpec> {
  const [sibling] = await db
    .select({
      kind: chapterVariants.kind,
      label: chapterVariants.label,
      prompt: chapterVariants.prompt,
      params: chapterVariants.params,
    })
    .from(chapterVariants)
    .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
    .where(and(eq(chapters.bookId, bookId), eq(chapterVariants.key, key)))
    .limit(1);
  if (sibling) return sibling;

  const preset = getTransformPreset(key);
  if (preset) {
    return {
      kind: "transform",
      label: preset.label,
      prompt: preset.prompt,
      params: { temperature: preset.temperature, mode: preset.mode },
    };
  }
  if (key.startsWith("custom-")) throw new Error(`No existing "${key}" variant to copy the prompt from`);
  return { kind: "translation", label: null, prompt: null, params: null };
}

function queuedLogLine(spec: { kind: string; label: string | null }, key: string) {
  return spec.kind === "translation"
    ? `Queued translation to ${key}`
    : `Queued ${spec.label ?? key} rewrite`;
}

export const variantsRouter = router({
  presets: publicProcedure.query(() => TRANSFORM_PRESETS),

  get: publicProcedure
    .input(z.object({ chapterId: z.string().uuid(), key: z.string().min(1) }))
    .query(async ({ input }) => {
      const [row] = await db
        .select()
        .from(chapterVariants)
        .where(and(
          eq(chapterVariants.chapterId, input.chapterId),
          eq(chapterVariants.key, input.key),
        ));
      return row ?? null;
    }),

  listForBook: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), key: z.string().min(1) }))
    .query(async ({ input }) => {
      const bookChapters = db
        .select({ id: chapters.id })
        .from(chapters)
        .where(eq(chapters.bookId, input.bookId));
      return db
        .select({
          id: chapterVariants.id,
          chapterId: chapterVariants.chapterId,
          key: chapterVariants.key,
          kind: chapterVariants.kind,
          label: chapterVariants.label,
          status: chapterVariants.status,
          title: chapterVariants.title,
          progress: chapterVariants.progress,
          error: chapterVariants.error,
          wordCount: sql<number>`coalesce(array_length(regexp_split_to_array(nullif(trim(${chapterVariants.text}), ''), '\\s+'), 1), 0)`,
          audioStatus: chapterVariants.audioStatus,
          audioProgress: chapterVariants.audioProgress,
          audioError: chapterVariants.audioError,
          audioDurationMs: chapterVariants.audioDurationMs,
          hasAudio: sql<boolean>`${chapterVariants.audioPath} is not null`,
          updatedAt: chapterVariants.updatedAt,
        })
        .from(chapterVariants)
        .where(and(
          inArray(chapterVariants.chapterId, bookChapters),
          eq(chapterVariants.key, input.key),
        ));
    }),

  detail: publicProcedure
    .input(z.object({ chapterId: z.string().uuid(), key: z.string().min(1) }))
    .query(async ({ input }) => {
      const [row] = await db
        .select()
        .from(chapterVariants)
        .where(and(
          eq(chapterVariants.chapterId, input.chapterId),
          eq(chapterVariants.key, input.key),
        ));
      if (!row) throw new Error("Variant not found");

      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.chapterId));
      if (!chapter) throw new Error("Chapter not found");

      const slug = languageSlug(row.key);
      const base = `ch${String(chapter.index).padStart(3, "0")}`;
      let previews = await listChunkPreviewsIn(
        translationChunkPreviewDir(chapter.bookId, row.key, chapter.index),
        `/files/${chapter.bookId}/chunks/${slug}/${base}`,
      );
      if (previews.length === 0) {
        const cacheKey = await audioCacheKey(row.audioPath);
        previews = await syncMapChunkPreviews(row.audioPath, `/audio/translation/${row.id}${cacheKey}`);
      }
      const ranges = locateChunks(row.text, previews.map((p) => p.text ?? ""));
      const blocks = Array.isArray(chapter.sourceBlocks) ? (chapter.sourceBlocks as SourceBlock[]) : [];
      const variantLength = Math.max(row.text?.length ?? 0, 1);
      const chunkPreviews = previews.map((preview, i) => {
        const range = ranges[i];
        if (!range) return preview;
        // Variant offsets don't map to source blocks; scale onto rawText for an approximate page.
        const rawOffset = Math.round((range.start / variantLength) * chapter.rawText.length);
        const page = pageAtOffset(blocks, chapter.rawText.length, rawOffset) ?? chapter.pageStart ?? undefined;
        return { ...preview, start: range.start, end: range.end, ...(page !== undefined ? { page } : {}) };
      });

      return { ...row, chunkPreviews };
    }),

  list: publicProcedure
    .input(z.object({ bookId: z.string().uuid() }))
    .query(async ({ input }) => {
      return db
        .select({
          key: chapterVariants.key,
          kind: sql<"translation" | "transform">`min(${chapterVariants.kind})`,
          label: sql<string | null>`min(${chapterVariants.label})`,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${chapterVariants.status} = 'done')::int`,
        })
        .from(chapterVariants)
        .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
        .where(eq(chapters.bookId, input.bookId))
        .groupBy(chapterVariants.key)
        .orderBy(chapterVariants.key);
    }),

  start: publicProcedure
    .input(z.object({
      chapterId: z.string().uuid(),
      key: z.string().min(1),
      restart: z.boolean().optional(),
      thinking: z.boolean().optional(),
      model: modelKeySchema.optional(),
    }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.chapterId));
      if (!chapter) throw new Error("Chapter not found");

      const [existing] = await db
        .select()
        .from(chapterVariants)
        .where(and(
          eq(chapterVariants.chapterId, input.chapterId),
          eq(chapterVariants.key, input.key),
        ));

      if (
        existing &&
        ["pending", "translating"].includes(existing.status) &&
        Date.now() - existing.updatedAt.getTime() < STALE_RUNNING_MS
      ) {
        throw new Error("Variant is already running");
      }

      let variantId: string;
      if (existing) {
        const reset = input.restart || existing.status === "done";
        const [updated] = await db
          .update(chapterVariants)
          .set({
            status: "pending",
            error: null,
            updatedAt: new Date(),
            ...(reset ? { text: "", progress: null, title: null } : {}),
            params: {
              ...existing.params,
              ...(input.thinking !== undefined && { thinking: input.thinking }),
              ...(input.model !== undefined && { model: input.model }),
            },
          })
          .where(eq(chapterVariants.id, existing.id))
          .returning({ id: chapterVariants.id });
        if (!updated) throw new Error("Failed to update the variant");
        variantId = updated.id;
        await deleteQueuedTranslateJobs([variantId]);
        await appendLog(chapter.bookId, `[Ch ${chapter.index + 1}] ${queuedLogLine(existing, input.key)}`);
      } else {
        const spec = await resolveSpec(chapter.bookId, input.key);
        spec.params = {
          ...spec.params,
          ...(input.thinking !== undefined && { thinking: input.thinking }),
          ...(input.model !== undefined && { model: input.model }),
        };
        const [created] = await db
          .insert(chapterVariants)
          .values({ chapterId: input.chapterId, key: input.key, ...spec })
          .returning({ id: chapterVariants.id });
        if (!created) throw new Error("Failed to create the variant");
        variantId = created.id;
        await appendLog(chapter.bookId, `[Ch ${chapter.index + 1}] ${queuedLogLine(spec, input.key)}`);
      }

      await db
        .update(books)
        .set({ translationLanguage: input.key, updatedAt: new Date() })
        .where(eq(books.id, chapter.bookId));

      await quickAddJob({ connectionString }, "translate", { translationId: variantId, bookId: chapter.bookId }, { maxAttempts: 1 });

      const [row] = await db.select().from(chapterVariants).where(eq(chapterVariants.id, variantId));
      return row;
    }),

  createTransform: publicProcedure
    .input(z.object({
      chapterId: z.string().uuid(),
      presetId: z.string().optional(),
      prompt: z.string().min(1),
      label: z.string().optional(),
      thinking: z.boolean().optional(),
      model: modelKeySchema.optional(),
    }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.chapterId));
      if (!chapter) throw new Error("Chapter not found");

      const preset = input.presetId ? getTransformPreset(input.presetId) : undefined;
      if (input.presetId && !preset) throw new Error(`Unknown preset "${input.presetId}"`);

      const label = input.label?.trim() || preset?.label || await inferVariantLabel(input.prompt);
      const key = preset ? preset.id : `custom-${variantKeySlug(label)}`;
      if (!preset && key === "custom-") throw new Error("Variant name is empty");
      const params: VariantParams = {
        temperature: preset?.temperature ?? 0.8,
        mode: preset?.mode ?? "chunked",
        ...(input.thinking !== undefined && { thinking: input.thinking }),
        ...(input.model !== undefined && { model: input.model }),
      };
      const spec: VariantSpec = { kind: "transform", label, prompt: input.prompt, params };

      const [existing] = await db
        .select()
        .from(chapterVariants)
        .where(and(eq(chapterVariants.chapterId, input.chapterId), eq(chapterVariants.key, key)));

      if (
        existing &&
        ["pending", "translating"].includes(existing.status) &&
        Date.now() - existing.updatedAt.getTime() < STALE_RUNNING_MS
      ) {
        throw new Error(`${label} is already running for this chapter`);
      }

      let variantId: string;
      if (existing) {
        const [updated] = await db
          .update(chapterVariants)
          .set({
            ...spec,
            status: "pending",
            error: null,
            text: "",
            progress: null,
            title: null,
            updatedAt: new Date(),
          })
          .where(eq(chapterVariants.id, existing.id))
          .returning({ id: chapterVariants.id });
        if (!updated) throw new Error("Failed to update the variant");
        variantId = updated.id;
        await deleteQueuedTranslateJobs([variantId]);
      } else {
        const [created] = await db
          .insert(chapterVariants)
          .values({ chapterId: input.chapterId, key, ...spec })
          .returning({ id: chapterVariants.id });
        if (!created) throw new Error("Failed to create the variant");
        variantId = created.id;
      }

      await db
        .update(books)
        .set({ translationLanguage: key, updatedAt: new Date() })
        .where(eq(books.id, chapter.bookId));

      await appendLog(chapter.bookId, `[Ch ${chapter.index + 1}] Queued ${label} rewrite`);
      await quickAddJob({ connectionString }, "translate", { translationId: variantId, bookId: chapter.bookId }, { maxAttempts: 1 });

      const [row] = await db.select().from(chapterVariants).where(eq(chapterVariants.id, variantId));
      return row;
    }),

  processSelected: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const rows = await db
        .select({
          chapterId: chapters.id,
          variantId: chapterVariants.id,
          status: chapterVariants.status,
          updatedAt: chapterVariants.updatedAt,
        })
        .from(chapters)
        .leftJoin(chapterVariants, and(
          eq(chapterVariants.chapterId, chapters.id),
          eq(chapterVariants.key, input.key),
        ))
        .where(and(eq(chapters.bookId, input.bookId), eq(chapters.selected, true)))
        .orderBy(asc(chapters.index));

      // Done chapters are skipped, suspended/failed ones resume; a fresh running one is left alone.
      const queueable = rows.filter((r) =>
        !r.variantId ||
        r.status === "failed" ||
        r.status === "suspended" ||
        (["pending", "translating"].includes(r.status!) && Date.now() - r.updatedAt!.getTime() >= STALE_RUNNING_MS),
      );
      if (queueable.length === 0) throw new Error(`No selected chapters need "${input.key}"`);

      const spec = await resolveSpec(input.bookId, input.key);
      const variantIds: string[] = [];
      for (const r of queueable) {
        if (r.variantId) {
          await db
            .update(chapterVariants)
            .set({ status: "pending", error: null, updatedAt: new Date() })
            .where(eq(chapterVariants.id, r.variantId));
          variantIds.push(r.variantId);
        } else {
          const [created] = await db
            .insert(chapterVariants)
            .values({ chapterId: r.chapterId, key: input.key, ...spec })
            .returning({ id: chapterVariants.id });
          if (!created) throw new Error("Failed to create the variant");
          variantIds.push(created.id);
        }
      }

      await db
        .update(books)
        .set({ translationLanguage: input.key, updatedAt: new Date() })
        .where(eq(books.id, input.bookId));

      await deleteQueuedTranslateJobs(variantIds);
      await appendLog(input.bookId, `${queuedLogLine(spec, input.key)} — ${variantIds.length} chapter${variantIds.length === 1 ? "" : "s"}`);
      for (const vid of variantIds) {
        await quickAddJob({ connectionString }, "translate", { translationId: vid, bookId: input.bookId }, { maxAttempts: 1 });
      }
      return { queued: variantIds.length };
    }),

  translateMissingTitles: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const rows = await db
        .select({ id: chapterVariants.id })
        .from(chapterVariants)
        .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
        .where(and(
          eq(chapters.bookId, input.bookId),
          eq(chapterVariants.key, input.key),
          eq(chapterVariants.kind, "translation"),
          eq(chapterVariants.status, "done"),
          sql`${chapterVariants.title} IS NULL`,
        ));
      if (rows.length === 0) throw new Error(`No finished ${input.key} translations are missing a title`);

      await appendLog(input.bookId, `Queued ${input.key} title translation for ${rows.length} chapter${rows.length === 1 ? "" : "s"}`);
      await quickAddJob(
        { connectionString },
        "translateTitles",
        { bookId: input.bookId, language: input.key },
        { maxAttempts: 1, jobKey: `translateTitles:${input.bookId}:${input.key}` },
      );
      return { queued: rows.length };
    }),

  setVoice: publicProcedure
    .input(z.object({
      bookId: z.string().uuid(),
      key: z.string().min(1),
      voice: z.string().min(1).optional(),
      speed: z.number().min(0.5).max(2.0).optional(),
    }))
    .mutation(async ({ input }) => {
      if (input.voice !== undefined) parseTtsVoice(input.voice);
      const [book] = await db.select().from(books).where(eq(books.id, input.bookId));
      if (!book) throw new Error("Book not found");
      const lane = {
        ...book.variantVoices?.[input.key],
        ...(input.voice !== undefined ? { voice: input.voice } : {}),
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
      };
      const variantVoices = { ...book.variantVoices, [input.key]: lane };
      await db.update(books).set({ variantVoices, updatedAt: new Date() }).where(eq(books.id, input.bookId));
      return lane;
    }),

  queueAudio: publicProcedure
    .input(z.object({ chapterId: z.string().uuid(), key: z.string().min(1), resume: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.chapterId));
      if (!chapter) throw new Error("Chapter not found");

      const [row] = await db
        .select()
        .from(chapterVariants)
        .where(and(
          eq(chapterVariants.chapterId, input.chapterId),
          eq(chapterVariants.key, input.key),
        ));
      if (!row || row.status !== "done") throw new Error(`${input.key} text is not finished`);
      if (row.audioStatus === "synthesizing" || row.audioStatus === "pending") {
        throw new Error("Chapter audio is already being processed");
      }

      await db
        .update(chapterVariants)
        .set({
          audioStatus: "pending",
          audioError: null,
          updatedAt: new Date(),
          ...(input.resume ? {} : { audioProgress: null }),
        })
        .where(eq(chapterVariants.id, row.id));

      await appendLog(chapter.bookId, `[Ch ${chapter.index + 1}] Queued ${variantLabel(row)} synthesis`);
      await quickAddJob(
        { connectionString },
        "synthesizeTranslation",
        { translationId: row.id, bookId: chapter.bookId, resume: input.resume ?? false },
        { maxAttempts: 1 },
      );

      const [updated] = await db.select().from(chapterVariants).where(eq(chapterVariants.id, row.id));
      return updated;
    }),

  processSelectedAudio: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const rows = await db
        .select({
          id: chapterVariants.id,
          status: chapterVariants.status,
          audioStatus: chapterVariants.audioStatus,
          chapterIndex: chapters.index,
        })
        .from(chapterVariants)
        .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
        .where(and(
          eq(chapters.bookId, input.bookId),
          eq(chapters.selected, true),
          eq(chapterVariants.key, input.key),
          inArray(chapterVariants.status, ["done", "pending", "translating"]),
        ))
        .orderBy(asc(chapters.index));

      const queueable = rows.filter((r) => r.audioStatus !== "synthesizing" && r.audioStatus !== "pending");
      if (queueable.length === 0) throw new Error(`No selected chapters with finished or in-progress "${input.key}" text to synthesize`);

      await db
        .update(chapterVariants)
        .set({ audioStatus: "pending", audioError: null, audioProgress: null, updatedAt: new Date() })
        .where(inArray(chapterVariants.id, queueable.map((r) => r.id)));

      // Chapters still generating only get the pending marker; the translate worker enqueues their job on completion.
      const ready = queueable.filter((r) => r.status === "done");
      const deferred = queueable.length - ready.length;
      await appendLog(
        input.bookId,
        `Queued ${queueable.length} chapter${queueable.length === 1 ? "" : "s"} for ${input.key} synthesis` +
          (deferred > 0 ? ` (${deferred} will start when the text finishes)` : ""),
      );
      for (const r of ready) {
        await quickAddJob(
          { connectionString },
          "synthesizeTranslation",
          { translationId: r.id, bookId: input.bookId },
          { maxAttempts: 1 },
        );
      }
      return { queued: queueable.length, deferred };
    }),

  stopAudio: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const bookChapters = db
        .select({ id: chapters.id })
        .from(chapters)
        .where(eq(chapters.bookId, input.bookId));

      const stopped = await db
        .update(chapterVariants)
        .set({ audioStatus: "suspended", updatedAt: new Date() })
        .where(and(
          inArray(chapterVariants.chapterId, bookChapters),
          eq(chapterVariants.key, input.key),
          inArray(chapterVariants.audioStatus, ["pending", "synthesizing"]),
        ))
        .returning({ id: chapterVariants.id });

      await db.execute(sql`
        DELETE FROM graphile_worker._private_jobs j
        USING graphile_worker._private_tasks t
        WHERE t.id = j.task_id AND t.identifier = 'synthesizeTranslation'
          AND (j.payload ->> 'bookId') = ${input.bookId}
          AND j.locked_at IS NULL
      `);

      if (stopped.length > 0) {
        await appendLog(input.bookId, `Stopped ${input.key} synthesis (${stopped.length} chapter${stopped.length === 1 ? "" : "s"})`);
      }
      return { stopped: stopped.length };
    }),

  selectedAudioSize: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), key: z.string().min(1) }))
    .query(async ({ input }) => {
      const rows = await db
        .select({ index: chapters.index, audioPath: chapterVariants.audioPath })
        .from(chapterVariants)
        .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
        .where(and(
          eq(chapters.bookId, input.bookId),
          eq(chapters.selected, true),
          eq(chapterVariants.key, input.key),
        ));

      let bytes = 0;
      let count = 0;
      for (const row of rows) {
        let rowBytes = 0;
        if (row.audioPath) {
          rowBytes += (await stat(row.audioPath).catch(() => null))?.size ?? 0;
        }
        rowBytes += await dirSize(translationChunkPreviewDir(input.bookId, input.key, row.index));
        if (rowBytes > 0) {
          bytes += rowBytes;
          count++;
        }
      }
      return { bytes, count };
    }),

  deleteAudioSelected: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const rows = await db
        .select({
          id: chapterVariants.id,
          index: chapters.index,
          audioPath: chapterVariants.audioPath,
          audioStatus: chapterVariants.audioStatus,
          audioProgress: chapterVariants.audioProgress,
        })
        .from(chapterVariants)
        .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
        .where(and(
          eq(chapters.bookId, input.bookId),
          eq(chapters.selected, true),
          eq(chapterVariants.key, input.key),
        ));

      if (rows.some((r) => r.audioStatus === "synthesizing")) {
        throw new Error("Cannot delete audio while chapters are synthesizing");
      }

      const targets = rows.filter((r) => r.audioPath || r.audioProgress);
      for (const t of targets) {
        if (t.audioPath) await unlink(t.audioPath).catch(() => {});
        await rm(translationChunkPreviewDir(input.bookId, input.key, t.index), { recursive: true, force: true }).catch(() => {});
      }

      if (targets.length > 0) {
        await db
          .update(chapterVariants)
          .set({
            audioPath: null,
            audioDurationMs: null,
            audioProgress: null,
            audioError: null,
            synthesizedWith: null,
            audioStatus: "suspended",
            updatedAt: new Date(),
          })
          .where(inArray(chapterVariants.id, targets.map((t) => t.id)));
        await appendLog(input.bookId, `Deleted ${input.key} audio of ${targets.length} chapter(s) — variant text kept`);
      }

      return { count: targets.length };
    }),

  assemble: publicProcedure
    .input(z.object({ bookId: z.string().uuid(), key: z.string().min(1), waitForAll: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const [book] = await db.select().from(books).where(eq(books.id, input.bookId));
      if (!book) throw new Error("Book not found");
      if (book.status === "assembling") throw new Error("Assembly already in progress");

      const waiting = input.waitForAll ? await inFlightInputs(input.bookId, input.key, "audio") : 0;
      await appendLog(input.bookId, waiting > 0
        ? `Queued ${input.key} assembly once ${waiting} chapter${waiting !== 1 ? "s" : ""} finish${waiting === 1 ? "es" : ""}`
        : `Queued ${input.key} assembly`);
      await quickAddJob(
        { connectionString },
        "assemble",
        { bookId: input.bookId, language: input.key, waitForAll: input.waitForAll },
        { maxAttempts: 1, jobKey: assembleJobKey(input.bookId, input.key), jobKeyMode: "replace" },
      );
      return { success: true };
    }),

  stop: publicProcedure
    .input(z.object({ chapterId: z.string().uuid(), key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const [chapter] = await db.select().from(chapters).where(eq(chapters.id, input.chapterId));
      if (!chapter) throw new Error("Chapter not found");

      const [row] = await db
        .update(chapterVariants)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(and(
          eq(chapterVariants.chapterId, input.chapterId),
          eq(chapterVariants.key, input.key),
          inArray(chapterVariants.status, ["pending", "translating"]),
        ))
        .returning();

      if (row) {
        await db.execute(sql`
          DELETE FROM graphile_worker._private_jobs j
          USING graphile_worker._private_tasks t
          WHERE t.id = j.task_id AND t.identifier = 'translate'
            AND (j.payload ->> 'translationId') = ${row.id}
            AND j.locked_at IS NULL
        `);
        await appendLog(chapter.bookId, `[Ch ${chapter.index + 1}] ${variantLabel(row)} stop requested`);
      }

      return row ?? null;
    }),
});
