import { inferLanguage } from "../lib/document-html.ts";
import { alignVectors } from "../lib/bilingual-align.ts";
import { sentences, tokenize } from "../lib/bilingual-segment.ts";
import { bilingualContext, failPreparation, isPreparationRunning, jobColumn, preparation, publishPreparation, type PreparationStage } from "../lib/bilingual-store.ts";
import { PAIRING_VERSION, TOKENIZER_VERSION, LINK_PROMPT_VERSION, matchesTexts, type PairArtifact } from "../lib/bilingual-preparation.ts";
import { BILINGUAL_FORMAT, readBilingualDocument, textRevision, type BilingualPair, type BilingualToken } from "../lib/bilingual-format.ts";
import { embedTexts } from "../lib/embeddings.ts";
import { languageCode } from "../lib/readaloud-epub.ts";
import { bundleInstalled } from "../lib/model-bundles.ts";
import { appendLog } from "../lib/log.ts";
import { linkBatches, requestWordLinks } from "../lib/bilingual-links.ts";

export type PrepareBilingualPayload = { variantId: string; runId: string; bookId: string; stage: PreparationStage; sourceRevision: string; targetRevision: string };

export async function prepareBilingual({ variantId, runId, stage, bookId, sourceRevision, targetRevision }: PrepareBilingualPayload) {
  const initial = await preparation(variantId), job = initial?.[jobColumn(stage)];
  if (!job || job.runId !== runId || job.status !== "queued") return;
  try {
    const context = await bilingualContext(variantId);
    if (textRevision(context.source) !== sourceRevision || textRevision(context.target) !== targetRevision) throw new Error("Text changed after preparation was queued. Prepare again.");
    const captured = { source: context.source, target: context.target, pairRevision: initial?.pairs?.revision };
    const publish = (change: Parameters<typeof publishPreparation>[4]) => publishPreparation(variantId, stage, runId, captured, change);
    const log = (message: string) => appendLog(context.chapter.bookId, `[Ch ${context.chapter.index + 1}] Bilingual ${stage}: ${message}`);
    if (!(await publish({ job: { status: "running", error: null } }))) return;
    await log("started");
    if (stage === "pairs") {
      if (!(await bundleInstalled("search"))) throw new Error("Install the optional search model bundle before pairing sentences");
      const sourceLanguage = context.language ? languageCode(context.language) : inferLanguage(context.source.slice(0, 2000)), targetLanguage = languageCode(context.variant.key);
      const src = sentences(context.source, sourceLanguage), tgt = sentences(context.target, targetLanguage);
      if (src.length * tgt.length > 2_000_000) throw new Error("Chapter is too large to pair; split it into smaller chapters");
      const texts = [...src.map((s) => context.source.slice(s.start, s.end)), ...tgt.map((s) => context.target.slice(s.start, s.end))];
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += 32) {
        if (!(await publish({ job: { done: i, total: texts.length } }))) return;
        const batch = texts.slice(i, i + 32), result = await embedTexts(batch);
        if (result.length !== batch.length) throw new Error("Embedding model returned an incomplete batch");
        vectors.push(...result);
      }
      const aligned = await alignVectors(src, tgt, vectors, () => isPreparationRunning(variantId, stage, runId));
      if (!aligned) return;
      const tokens = (text: string, locale: string): BilingualToken[] => tokenize(text, { start: 0, end: text.length }, locale).map((t) => ({ id: t.id, range: [t.start, t.end] }));
      const pairs: BilingualPair[] = aligned.map((p) => ({ id: p.id, status: p.status,
        source: p.s ? [p.s.start, p.s.end] : null, target: p.t ? [p.t.start, p.t.end] : null, linksStatus: "unavailable", links: [] }));
      const data = { aligner: PAIRING_VERSION, tokenizer: TOKENIZER_VERSION,
        source: { id: "original", language: sourceLanguage, text: context.source, textRevision: textRevision(context.source), tokens: tokens(context.source, sourceLanguage) },
        target: { id: context.variant.id, language: targetLanguage, text: context.target, textRevision: textRevision(context.target), tokens: tokens(context.target, targetLanguage) }, pairs };
      readBilingualDocument({ format: BILINGUAL_FORMAT, chapterId: context.chapter.id, key: context.variant.key,
        tokenizer: data.tokenizer, source: { ...data.source, narration: null }, target: { ...data.target, narration: null }, pairs });
      const artifact: PairArtifact = { ...data, revision: textRevision(JSON.stringify(data)) };
      if (!(await publish({ pairs: artifact, job: { status: "done", done: texts.length, total: texts.length } }))) return;
      await log(`${pairs.length} sentence groups ready`);
    } else {
      const artifact = initial?.pairs;
      if (!artifact || !matchesTexts(artifact, context.source, context.target)) throw new Error("Prepare current sentence pairs before linking words");
      if (!job.model) throw new Error("Choose a model for word links");
      const links = initial?.links?.pairRevision === artifact.revision ? structuredClone(initial.links)
        : { pairRevision: artifact.revision, promptVersion: LINK_PROMPT_VERSION, byPair: {}, batches: [] };
      const batches = linkBatches(artifact, links.byPair);
      // An invalid answer fails its batch, not the ones after it: stopping there let a sentence group
      // the model always answered wrongly block the rest of the chapter, retry after retry, because
      // the retry's first batch starts with that same group. A provider error still ends the run.
      const incomplete: string[] = [];
      for (const [i, batch] of batches.entries()) {
        if (!(await publish({ job: { done: i, total: batches.length } }))) return;
        const result = await requestWordLinks(artifact, batch, job.model);
        links.batches.push(result.record);
        if (result.links) Object.assign(links.byPair, result.links);
        if (!(await publish({ links, job: { done: i + 1, total: batches.length } }))) return;
        if (result.record.error) {
          incomplete.push(result.record.error);
          await log(`batch ${i + 1}/${batches.length} incomplete: ${result.record.error}`);
          continue;
        }
        await log(`linked batch ${i + 1}/${batches.length}`);
      }
      if (incomplete.length === 1) throw new Error(incomplete[0]);
      if (incomplete.length > 1) throw new Error(`${incomplete.length} of ${batches.length} batches incomplete: ${incomplete.slice(0, 3).join(" | ")}`);
      if (!(await publish({ links, job: { status: "done", done: batches.length, total: batches.length } }))) return;
      await log("word links ready");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failPreparation(variantId, stage, runId, message);
    await appendLog(bookId, `Bilingual ${stage} failed: ${message}`);
    throw error;
  }
}
