import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NoObjectGeneratedError, Output, generateText, type LanguageModel } from "ai";
import { z } from "zod";

import { resolveLlm, type LlmModelDef } from "./llm.ts";
import { ExtractAbortedError } from "./marker.ts";
import { detectScript, pdfPageSizes, parseTsv, type OcrPage, type PdfPageSize } from "./ocr-tesseract.ts";
import { pdfHasTextLayer } from "./pdf-raw-text.ts";
import { writeTextLayer, type TextLayerPage, type TextLayerWriter } from "./pdf-text-layer.ts";
import { packsForScript, tesseractLanguage } from "./tesseract-languages.ts";
import { ensureTessdata, installedPacks, tesseractEnv } from "./tessdata.ts";
import type { Box } from "./word-alignment.ts";
import { placeOcrPage, reconcileNativeBlocks } from "./ocr-geometry.ts";
import { OCR_GEOMETRY_FILE, type GeometryPage, type SourceGeometry } from "./page-geometry.ts";

const execFileAsync = promisify(execFile);

// The model supplies transcription and structure. Tesseract supplies measured word positions.
// The native geometry and searchable PDF are parallel outputs of the same text-to-word mapping.
export const LLM_LAYOUT_FILE = "llm-layout.json";
export const LLM_LAYOUT_META_FILE = "llm-layout_meta.json";
// The model's pages as read, before joining and placement: what the paid call bought, kept so the
// placement can be run again locally when the readers or the alignment improve.
export const LLM_PAGES_FILE = "llm-pages.json";

// DeepSeek resamples anything above ~1.69M pixels, so 1600 on the long edge of a portrait page is
// the most detail the model ever reads; a larger render only costs upload bytes.
export const LLM_PAGE_EDGE = 1600;
const RENDER_CHUNK_PAGES = 20;
const CONCURRENCY = 4;
const CALL_TIMEOUT_MS = 10 * 60 * 1000;
const PARSE_ATTEMPTS = 3;

// Below this share of the local OCR's words the answer is treated as short of the page and asked
// for once more with anchors. From the POC book: clean pages score 92–100, a page with its opening
// paragraph dropped 71–84.
export const RETRY_BELOW_RECALL = 0.88;

// Per page on the POC book, structured JSON included; the picker's cost preview multiplies these.
export const LLM_TOKENS_PER_PAGE = { input: 1500, output: 1700 };
export const LLM_PRICE_PER_MILLION_USD = { input: 0.15, output: 0.6 };

export function estimateLlmOcrCostUsd(pages: number): number {
  return (pages * LLM_TOKENS_PER_PAGE.input * LLM_PRICE_PER_MILLION_USD.input + pages * LLM_TOKENS_PER_PAGE.output * LLM_PRICE_PER_MILLION_USD.output) / 1_000_000;
}

const SYSTEM_PROMPT = `You transcribe one scanned book page from its image into structured JSON. Rules:
- Transcribe the body text verbatim, in the page's own language and script. Do not translate, summarise, modernise spelling, or fix the author's wording. Keep the original punctuation.
- Start at the very first line of text on the page and stop at the last. A page usually begins with the tail of a sentence from the previous page — a fragment with no indent and no capital letter. That fragment is the first block; never skip it to start at the first indented paragraph.
- Every line of body text must appear in some block. Do not omit, shorten or merge passages.
- A word split across two lines by a hyphen at the line end is one word: write it joined, with no hyphen and no space. Keep a hyphen only when it is part of the word itself or a dash between words.
- One block per paragraph; join the lines of a paragraph with single spaces. Keep paragraph breaks as separate blocks.
- Headings (chapter titles, section titles) are blocks of type "heading" with a level: 1 for a chapter or part title, 2 for a section, 3 for a subsection.
- List items are blocks of type "list_item", one per item.
- Footnotes, captions, tables and poetry are blocks of type "other", kept verbatim.
- Running headers, running footers, page numbers, signature marks and printer's marks go into "furniture", one string each, verbatim. Never put them into a block and never drop them.
- "continues" is true when the last body block on the page ends mid-sentence or mid-paragraph and carries on at the top of the next page; false when the page ends at a paragraph end.
- If the page is blank or has no text, return an empty blocks list.
Return only the JSON object.`;

// The model's vocabulary drifts — "text" for "paragraph", "content" for "text", a null level, a
// stray top-level key echoing the response format — and a strict enum turned half the POC book's
// pages into three failed attempts each. Only the shape is enforced; names are normalised after.
const RawPageSchema = z.object({
  blocks: z.array(z.object({
    type: z.string().default("paragraph"),
    level: z.number().int().min(1).max(6).nullable().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
  })),
  furniture: z.array(z.string()).default([]),
  continues: z.boolean().default(false),
});
export type RawLlmPage = z.infer<typeof RawPageSchema>;

export const LLM_BLOCK_TYPES = ["heading", "paragraph", "list_item", "other"] as const;
export type LlmBlockType = (typeof LLM_BLOCK_TYPES)[number];
export type LlmBlock = {
  type: LlmBlockType;
  level?: number;
  text: string;
  /** [x0, y0, x1, y1] in PDF points of the displayed page, origin top-left; absent when nothing placed it */
  polygon?: Box;
};
export type LlmPage = { blocks: LlmBlock[]; furniture: string[]; continues: boolean };

export function normalizeBlockType(raw: string): LlmBlockType {
  const t = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (t === "heading" || t === "header" || t === "title" || t === "section_header") return "heading";
  if (t === "list_item" || t === "listitem" || t === "list" || t === "item") return "list_item";
  if (t === "paragraph" || t === "text" || t === "body" || t === "para") return "paragraph";
  return "other";
}

// The model "joins" a line-end hyphen by writing a soft hyphen (U+00AD) in its place, which looks
// joined and splits the word for search, TTS and the fidelity count alike. Zero-width marks go too.
export function cleanText(text: string): string {
  return text.replace(/\u00ad|\u200b|\u200c|\u200d|\ufeff/g, "").replace(/\s+/g, " ").trim();
}

export function normalizePage(raw: RawLlmPage): LlmPage {
  return {
    blocks: raw.blocks
      .map((b) => ({ type: normalizeBlockType(b.type), level: b.level ?? undefined, text: cleanText(b.text ?? b.content ?? "") }))
      .filter((b) => b.text)
      .map((b) => ({ type: b.type, ...(b.level ? { level: b.level } : {}), text: b.text })),
    furniture: raw.furniture.map(cleanText).filter(Boolean),
    continues: raw.continues,
  };
}

// A word split by a hyphen at the foot of a page is joined across the page break, the way words
// split at a line end are joined within it — the reason this engine exists. A paragraph that
// merely continues stays two blocks, one per page, as Marker leaves it: a block carries one page
// and one polygon, and a block glued across pages sent every cue in its second half to the first
// page's box. The reader draws a sentence across two blocks on its own.
export function joinContinuations(pages: (LlmPage | null)[]): (LlmPage | null)[] {
  const out = pages.map((p) => (p ? { ...p, blocks: p.blocks.map((b) => ({ ...b })) } : null));
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i];
    const next = out[i + 1];
    if (!cur?.continues || !next) continue;
    const tail = cur.blocks.at(-1);
    const head = next.blocks[0];
    if (!tail || !head || tail.type === "heading" || head.type === "heading" || !/\p{L}-$/u.test(tail.text)) continue;
    const [word, ...rest] = head.text.split(" ");
    tail.text = tail.text.slice(0, -1) + word;
    if (rest.length) head.text = rest.join(" ");
    else next.blocks.shift();
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function markerType(b: LlmBlock): string {
  switch (b.type) {
    case "heading": return "SectionHeader";
    case "list_item": return "ListItem";
    case "paragraph": return "Text";
    case "other": return "Text";
  }
}

// Exactly the shape collectBlocksFromMarkerJson reads: Document > Page > leaf blocks with html,
// `<hN>` carrying the heading level, the polygon in Marker's four-corner form when the block was
// placed. One Page entry per PDF page keeps numbering exact.
export function toMarkerJson(pages: (LlmPage | null)[]) {
  return {
    block_type: "Document",
    children: pages.map((page, i) => ({
      id: `/page/${i}`,
      block_type: "Page",
      html: "",
      section_hierarchy: null,
      children: (page?.blocks ?? []).map((b, j) => ({
        id: `/page/${i}/Block/${j}`,
        block_type: markerType(b),
        html: b.type === "heading" ? `<h${b.level ?? 2}>${escapeHtml(b.text)}</h${b.level ?? 2}>` : `<p>${escapeHtml(b.text)}</p>`,
        children: null,
        section_hierarchy: null,
        ...(b.polygon ? { polygon: [[b.polygon[0], b.polygon[1]], [b.polygon[2], b.polygon[1]], [b.polygon[2], b.polygon[3]], [b.polygon[0], b.polygon[3]]] } : {}),
      })),
    })),
    metadata: { table_of_contents: [] },
  };
}

// pdftotext separates pages with a form feed and the search index counts them to cite a page.
export function pagesToRawText(pages: (LlmPage | null)[]): string {
  return pages.map((p) => (p ? p.blocks.map((b) => b.text).join("\n\n") : "")).join("\f");
}

const WORD = /[\p{L}\p{N}]+/gu;
function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

// A local OCR keeps line-end hyphens; join them so a split word counts as one on both sides.
function normalizeReference(text: string): string {
  return text.replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2");
}

const SCRIPTS = [/\p{Script=Cyrillic}/u, /\p{Script=Latin}/u, /\p{Script=Greek}/u, /\p{Script=Han}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u];
function dominantScript(list: string[]): RegExp | null {
  let best: RegExp | null = null;
  let bestCount = 0;
  for (const re of SCRIPTS) {
    const n = list.filter((w) => re.test(w)).length;
    if (n > bestCount) {
      best = re;
      bestCount = n;
    }
  }
  return best;
}

export type Fidelity = {
  referenceWords: number;
  modelWords: number;
  /** Share of the reference's word occurrences found in the model's text. */
  recall: number;
  /** Share of the model's word occurrences found in the reference. */
  precision: number;
};

// The guard against the two failures a model has and OCR does not: silently omitting a passage,
// and rewording one. Counted on word multisets. Surya read the bleed-through on the POC book's
// last page as English and Chinese — a hundred words the page never had — so only reference
// words in the script the model's text is mostly written in count.
export function fidelity(modelText: string, referenceText: string): Fidelity {
  const mod = words(modelText);
  const script = dominantScript(mod);
  const ref = words(normalizeReference(referenceText)).filter((w) => !script || script.test(w));
  const count = (list: string[]) => {
    const m = new Map<string, number>();
    for (const w of list) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const refCount = count(ref);
  let hit = 0;
  for (const [w, n] of count(mod)) hit += Math.min(n, refCount.get(w) ?? 0);
  return {
    referenceWords: ref.length,
    modelWords: mod.length,
    recall: ref.length ? hit / ref.length : 1,
    precision: mod.length ? hit / mod.length : 1,
  };
}

function pageText(page: LlmPage): string {
  return page.blocks.map((b) => b.text).join("\n\n");
}

// The first and last lines a rough local OCR saw, so a second attempt knows where the page starts
// and ends. The model skipped an opening fragment on one POC page in every run and no wording in
// the system prompt made it stop; the anchors did. Marked rough so the model reads the image.
export function anchorHint(referenceText: string, previous: LlmPage): string {
  const lines = referenceText.split("\n").map((l) => l.trim()).filter((l) => words(l).length >= 3);
  if (lines.length === 0) return "";
  const first = lines.slice(0, 2).join(" ");
  const last = lines.slice(-2).join(" ");
  const expected = words(normalizeReference(referenceText)).length;
  const got = words(pageText(previous)).length;
  return `\n\nYour previous transcription of this page had about ${got} words; a rough OCR counts about ${expected}, so text was missed. `
    + `The page's first line reads roughly «${first}» and its last line roughly «${last}» (rough OCR, may contain errors — read the image). `
    + `Transcribe every line between them, starting with the very first.`;
}

export type LlmOcrStats = {
  pages: number;
  inputTokens: number;
  outputTokens: number;
  /** Mean recall against the local OCR, or null when no Tesseract pack could read the pages. */
  meanRecall: number | null;
  /** Share of pages still under RETRY_BELOW_RECALL after their second attempt. */
  lowRecallFraction: number | null;
  flaggedPages: number[];
  /** Mean share of the model's words that took a Tesseract box, or null when nothing was placed. */
  meanPlaced: number | null;
  /** True when `outPdfPath` now holds a copy with the placed words as its text layer. */
  searchableCopy: boolean;
  rawText: string;
};

export type LlmOcrInput = {
  pdfPath: string;
  /** The file's Marker output directory; the layout JSON is written here. */
  outDir: string;
  /** Where the searchable copy goes; none is written when omitted or when no word could be placed. */
  outPdfPath?: string;
  /** The book's ISO-639-1 code, or null when never set. */
  language: string | null;
  workDir: string;
  /** Registry key from lib/llm.ts; the Settings default when undefined. */
  modelKey?: string;
  log: (msg: string) => Promise<void>;
  signal?: AbortSignal;
};

export type Transcription = { page: RawLlmPage; inputTokens: number; outputTokens: number };
export type Transcriber = (input: { image: Buffer; mediaType: string; pageNumber: number; hint: string; signal: AbortSignal }) => Promise<Transcription>;

// An answer that came back but was not the JSON asked for. Worth a second call, unlike a provider
// error; the tokens it cost are carried so the run's total stays honest.
export class LlmPageParseError extends Error {
  constructor(cause: unknown, readonly inputTokens: number, readonly outputTokens: number) {
    super(`The model's answer was not a page transcription: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}`);
    this.name = "LlmPageParseError";
  }
}

export function makeLlmTranscriber(model: LanguageModel, def: LlmModelDef): Transcriber {
  return async ({ image, mediaType, pageNumber, hint, signal }) => {
    try {
      const res = await generateText({
        model,
        output: Output.object({ schema: RawPageSchema }),
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: [
          { type: "text", text: `Page ${pageNumber} of the book. Transcribe it.${hint}` },
          { type: "file", data: image, mediaType },
        ] }],
        ...(def.supportsTemperature ? { temperature: 0 } : {}),
        // Reasoning off: transcription has nothing to think about, and DeepSeek's default thinking
        // would multiply the output tokens the cost estimate is built on.
        ...(def.provider === "deepseek" ? { providerOptions: { deepseek: { thinking: { type: "disabled" } } } } : {}),
        abortSignal: signal,
      });
      return { page: res.output, inputTokens: res.usage.inputTokens ?? 0, outputTokens: res.usage.outputTokens ?? 0 };
    } catch (err) {
      // Thrown by the call itself when the answer is not valid JSON, or by `output` when it is
      // JSON of the wrong shape; either is the model's answer, not the provider failing.
      if (NoObjectGeneratedError.isInstance(err)) throw new LlmPageParseError(err, err.usage?.inputTokens ?? 0, err.usage?.outputTokens ?? 0);
      throw err;
    }
  };
}

/** One local reading supplies both the fidelity check and the measured positions. */
export type Reference = OcrPage;
/** null when no pack can read the page. */
export type ReferenceReader = (image: string, pageNumber: number) => Promise<Reference | null>;

function run(command: string, args: string[], signal: AbortSignal | undefined, timeout: number): Promise<{ stdout: string }> {
  if (signal?.aborted) throw new ExtractAbortedError();
  return execFileAsync(command, args, { signal, timeout, maxBuffer: 64 * 1024 * 1024, env: tesseractEnv() }).catch((err: NodeJS.ErrnoException) => {
    if (signal?.aborted) throw new ExtractAbortedError();
    throw err;
  });
}

// pdftoppm pads page numbers to the document's page count, not the range's, so names come off disk.
async function renderPages(pdfPath: string, workDir: string, pages: number, log: LlmOcrInput["log"], signal?: AbortSignal): Promise<string[]> {
  for (let first = 1; first <= pages; first += RENDER_CHUNK_PAGES) {
    const last = Math.min(first + RENDER_CHUNK_PAGES - 1, pages);
    await log(`Rendering pages ${first}–${last} of ${pages}`);
    await run("pdftoppm", ["-cropbox", "-scale-to", String(LLM_PAGE_EDGE), "-jpeg", "-jpegopt", "quality=85", "-gray", "-f", String(first), "-l", String(last), pdfPath, path.join(workDir, "pg")], signal, 600_000);
  }
  const rendered = (await readdir(workDir)).filter((f) => f.startsWith("pg-") && f.endsWith(".jpg")).sort();
  if (rendered.length !== pages) throw new Error(`Rendered ${rendered.length} of ${pages} pages before reading them`);
  return rendered.map((f) => path.join(workDir, f));
}

// WebP is a quarter of the PNG bytes at the same detail; the desktop app bundles pdftoppm and
// tesseract but not cwebp, so a machine without it sends the JPEG instead. Same tokens either way.
async function modelImage(jpeg: string, signal?: AbortSignal): Promise<{ data: Buffer; mediaType: string }> {
  const webp = jpeg.replace(/\.jpg$/, ".webp");
  try {
    await run("cwebp", ["-quiet", "-q", "80", jpeg, "-o", webp], signal, 120_000);
    return { data: await readFile(webp), mediaType: "image/webp" };
  } catch (err) {
    if (err instanceof ExtractAbortedError) throw err;
    return { data: await readFile(jpeg), mediaType: "image/jpeg" };
  }
}

// Tesseract in the book's language when its pack is installed, else the page's own script picks the
// pack. Nothing installed for the script means no Tesseract reading rather than a wrong-alphabet one.
async function chooseReferencePack(language: string | null, script: string | null, log: LlmOcrInput["log"]): Promise<string | null> {
  await ensureTessdata();
  const installed = await installedPacks();
  if (language) {
    try {
      const { pack, name } = tesseractLanguage(language);
      if (installed.includes(pack)) return pack;
      await log(`No ${name} Tesseract pack installed`);
      return null;
    } catch {
      await log(`Tesseract has no pack for the language "${language}"`);
      return null;
    }
  }
  const pack = packsForScript(script).find((p) => installed.includes(p)) ?? (script ? null : "eng");
  if (!pack) await log(`${script} script on the page and no Tesseract pack for it installed`);
  return pack;
}

async function makeReference(language: string | null, firstImage: string, pdfPath: string, workDir: string, log: LlmOcrInput["log"], signal?: AbortSignal): Promise<ReferenceReader> {
  const script = language ? null : await detectScript(firstImage);
  const pack = await chooseReferencePack(language, script, log);
  if (!pack) {
    await log("No local OCR pack: the AI text is kept without page positions");
    return async () => null;
  }
  await log(`Local reading: Tesseract (${pack}) for text comparison and measured word positions`);
  return async (_image, pageNumber) => {
    const base = path.join(workDir, `native-${pageNumber}`);
    const image = `${base}.png`;
    try {
      // Phone scans can report pixel dimensions as PDF points; bound the raster to A4 at 300 dpi.
      await run("pdftoppm", ["-cropbox", "-scale-to", "3508", "-png", "-gray", "-singlefile", "-f", String(pageNumber), "-l", String(pageNumber), pdfPath, base], signal, 300_000);
      return parseTsv((await run("tesseract", [image, "-", "-l", pack, "tsv"], signal, 300_000)).stdout);
    } finally {
      await rm(image, { force: true });
    }
  };
}

function placePage(page: LlmPage, reference: Reference | null, size: PdfPageSize, index: number) {
  const placed = placeOcrPage(page.blocks.map((b) => b.text), reference, size, index);
  return {
    page: { ...page, blocks: page.blocks.map(({ polygon: _old, ...block }, i) => {
      const polygon = placed.boxes[i];
      return polygon ? { ...block, polygon } : block;
    }) },
    geometry: placed.geometry,
    words: placed.layer,
    placed: reference ? placed.placement.matchedShare : null,
    doubtful: placed.placement.doubtful,
  };
}

function doubtNote(doubtful: string[]): string {
  if (doubtful.length === 0) return "";
  const shown = doubtful.slice(0, 5).join(", ");
  return `, ${doubtful.length} word${doubtful.length === 1 ? "" : "s"} the readers disagree on (${shown}${doubtful.length > 5 ? ", …" : ""})`;
}

async function pool<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  }));
}

type Prepared = { sizes: PdfPageSize[]; images: string[]; reference: ReferenceReader };

// The model gets compact images; native OCR renders losslessly at 300 dpi for measured positions.
async function withPreparedPages<T>(
  { pdfPath, workDir, language, log, signal }: Pick<LlmOcrInput, "pdfPath" | "workDir" | "language" | "log" | "signal">,
  reference: ReferenceReader | undefined,
  fn: (prepared: Prepared) => Promise<T>,
): Promise<T> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  try {
    const sizes = await pdfPageSizes(pdfPath);
    const images = await renderPages(pdfPath, workDir, sizes.length, log, signal);
    const firstImage = images[0];
    if (!firstImage) throw new Error("No rendered pages for OCR");
    return await fn({ sizes, images, reference: reference ?? await makeReference(language, firstImage, pdfPath, workDir, log, signal) });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// The model's pages as read, before joining and placement. Written as pages land, so a run that
// fails or is cancelled keeps what it paid for and the next one reads only the rest.
type SavedPages = { engine: "llm"; model: string; complete: boolean; outputFailed?: boolean; pages: (LlmPage | null)[] };

async function readSavedPages(outDir: string): Promise<SavedPages | null> {
  const raw = await readFile(path.join(outDir, LLM_PAGES_FILE), "utf-8").catch(() => null);
  if (!raw) return null;
  const saved = JSON.parse(raw) as Partial<SavedPages> & { pages: (LlmPage | null)[] };
  return { engine: "llm", model: saved.model ?? "llm", complete: saved.complete !== false, outputFailed: saved.outputFailed === true, pages: saved.pages };
}

// Writes are serialised and land whole: pages finish concurrently, and a run killed mid-write
// must not leave a file the next run cannot read.
function savedPagesWriter(outDir: string, model: string, pages: (LlmPage | null)[]): (complete: boolean, outputFailed?: boolean) => Promise<void> {
  const target = path.join(outDir, LLM_PAGES_FILE);
  let queue = Promise.resolve();
  return (complete, outputFailed = false) => (queue = queue.then(async () => {
    await writeFile(`${target}.part`, JSON.stringify({ engine: "llm", model, complete, outputFailed, pages } satisfies SavedPages));
    await rename(`${target}.part`, target);
  }));
}

type PageRead = { page: LlmPage; recall: number | null; anchored: boolean; inputTokens: number; outputTokens: number };

// One page through the model. An answer that is not a page is asked for again, up to
// PARSE_ATTEMPTS; an answer short of the local OCR is asked for once more with that OCR's first
// and last lines as anchors, and the better of the two is kept. A garbled second look keeps the
// first answer rather than costing the page.
async function readPage(transcribe: Transcriber, input: { image: Buffer; mediaType: string; pageNumber: number; referenceText: string | null; signal: AbortSignal }): Promise<PageRead> {
  let result: LlmPage | null = null;
  let recall: number | null = null;
  let parseFailures = 0;
  let anchored = false;
  let inputTokens = 0;
  let outputTokens = 0;
  while (true) {
    // A second look happens at most once, anchors or not: a reference with nothing to anchor to
    // must not turn a short page into an endless loop of paid calls.
    const hint = result && input.referenceText ? anchorHint(input.referenceText, result) : "";
    if (result) {
      anchored = true;
      if (!hint) break;
    }
    const callSignal = AbortSignal.any([input.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
    try {
      const t = await transcribe({ image: input.image, mediaType: input.mediaType, pageNumber: input.pageNumber, hint, signal: callSignal });
      inputTokens += t.inputTokens;
      outputTokens += t.outputTokens;
      const page = normalizePage(t.page);
      const score = input.referenceText ? fidelity(pageText(page), input.referenceText).recall : null;
      if (!result || score === null || recall === null || score >= recall) {
        result = page;
        recall = score;
      }
    } catch (err) {
      if (err instanceof LlmPageParseError) {
        inputTokens += err.inputTokens;
        outputTokens += err.outputTokens;
        if (result) break;
        if (++parseFailures < PARSE_ATTEMPTS) continue;
      }
      throw err;
    }
    if (recall !== null && recall < RETRY_BELOW_RECALL && !anchored && input.referenceText) continue;
    break;
  }
  return { page: result!, recall, anchored, inputTokens, outputTokens };
}

export function makeLlmOcrRunner(deps: { transcribe: Transcriber; reference?: ReferenceReader; modelLabel?: string; writeTextLayer?: TextLayerWriter }) {
  return (input: LlmOcrInput): Promise<LlmOcrStats> => withPreparedPages(input, deps.reference, async ({ sizes, images, reference }) => {
    const { pdfPath, outDir, outPdfPath, workDir, log, signal } = input;
    const total = sizes.length;
    const model = deps.modelLabel ?? "llm";
    const earlier = await readSavedPages(outDir);
    const raw: (LlmPage | null)[] = earlier && (!earlier.complete || earlier.outputFailed) && earlier.model === model && earlier.pages.length === total
      ? earlier.pages
      : Array.from({ length: total }, () => null);
    const reused = raw.filter(Boolean).length;
    await log(`Reading ${total - reused} page${total - reused === 1 ? "" : "s"} with ${deps.modelLabel ?? "the AI model"}${reused ? ` — ${reused} read by the run before` : ""}`);
    await mkdir(outDir, { recursive: true });
    const save = savedPagesWriter(outDir, model, raw);

    const pages: (LlmPage | null)[] = Array.from({ length: total }, () => null);
    const recalls: (number | null)[] = Array.from({ length: total }, () => null);
    const placedShares: (number | null)[] = Array.from({ length: total }, () => null);
    const doubtful: Record<number, string[]> = {};
    const layer: TextLayerPage[] = [];
    const geometry: GeometryPage[] = sizes.map((size, i) => placeOcrPage([], null, size, i).geometry);
    let inputTokens = 0;
    let outputTokens = 0;
    // One failing call ends the run: retrying into a provider error is retrying into a bill.
    const failure = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, failure.signal]) : failure.signal;
    let done = 0;

    await pool(images, CONCURRENCY, async (image, i) => {
      if (runSignal.aborted) return;
      const pageNumber = i + 1;
      try {
        const ref = await reference(image, pageNumber);
        let page = raw[i];
        let recall: number | null = null;
        let anchored = false;
        if (!page) {
          const { data, mediaType } = await modelImage(image, runSignal);
          const read = await readPage(deps.transcribe, { image: data, mediaType, pageNumber, referenceText: ref?.text || null, signal: runSignal });
          page = read.page;
          recall = read.recall;
          anchored = read.anchored;
          inputTokens += read.inputTokens;
          outputTokens += read.outputTokens;
          raw[i] = page;
          await save(false);
        }
        let placed: number | null = null;
        let doubt = "";
        {
          const size = sizes[i];
          if (!size) throw new Error(`No dimensions for page ${pageNumber}`);
          const placement = placePage(page, ref, size, i);
          geometry[i] = placement.geometry;
          page = placement.page;
          placed = placement.placed;
          if (placement.words.length) layer.push({ page: pageNumber, words: placement.words });
          if (placement.doubtful.length) doubtful[pageNumber] = placement.doubtful;
          doubt = doubtNote(placement.doubtful);
        }
        pages[i] = page;
        recalls[i] = recall;
        placedShares[i] = placed;
        done++;
        log(`AI read page ${pageNumber}/${total}${recall !== null ? ` — ${Math.round(recall * 100)}% of the local OCR's words${anchored ? ", after a second look" : ""}` : ""}${placed !== null ? `, ${Math.round(placed * 100)}% placed on the page` : ""}${doubt} (${done}/${total} done)`).catch(() => {});
      } catch (err) {
        failure.abort();
        if (signal?.aborted) throw new ExtractAbortedError();
        throw err;
      }
    });
    if (signal?.aborted) throw new ExtractAbortedError();
    await save(true, true);
    const { joined, meanPlaced, searchableCopy } = await writeOutputs({ pdfPath, outDir, outPdfPath, workDir, pages, layer, geometry, placedShares, doubtful, model, writer: deps.writeTextLayer, log, signal });
    await save(true, Boolean(outPdfPath) && !searchableCopy);

    const scored = recalls.filter((r): r is number => r !== null);
    const flaggedPages = recalls.flatMap((r, i) => (r !== null && r < RETRY_BELOW_RECALL ? [i + 1] : []));
    const meanRecall = scored.length ? scored.reduce((a, r) => a + r, 0) / scored.length : null;
    if (flaggedPages.length > 0) {
      await log(`Pages short of the local OCR even after a second look — check them in the structure view: ${flaggedPages.join(", ")}`);
    }
    return {
      pages: total,
      inputTokens,
      outputTokens,
      meanRecall,
      lowRecallFraction: scored.length ? flaggedPages.length / scored.length : null,
      flaggedPages,
      meanPlaced,
      searchableCopy,
      rawText: pagesToRawText(joined),
    };
  });
}

type Outputs = {
  pdfPath: string;
  outDir: string;
  outPdfPath?: string;
  workDir: string;
  pages: (LlmPage | null)[];
  layer: TextLayerPage[];
  geometry: GeometryPage[];
  placedShares: (number | null)[];
  doubtful: Record<number, string[]>;
  model: string;
  writer?: TextLayerWriter;
  requireCopy?: boolean;
  log: LlmOcrInput["log"];
  signal?: AbortSignal;
};

// Everything after the pages are placed: the joined layout, and the copy with the words in it.
async function writeOutputs({ pdfPath, outDir, outPdfPath, workDir, pages, layer, geometry, placedShares, doubtful, model, writer, requireCopy = false, log, signal }: Outputs): Promise<{ joined: (LlmPage | null)[]; meanPlaced: number | null; searchableCopy: boolean }> {
  const joined = joinContinuations(pages);
  reconcileNativeBlocks(geometry, joined.map((p) => p?.blocks.map((b) => b.text) ?? []));
  const placedScores = placedShares.filter((p): p is number => p !== null);
  const meanPlaced = placedScores.length ? placedScores.reduce((a, p) => a + p, 0) / placedScores.length : null;

  // The copy is a bonus on top of the reading, which is paid for by now: a writer that fails
  // is named in the log and the book goes on without in-PDF search, as it did before the copy.
  let searchableCopy = false;
  if (outPdfPath && layer.length > 0) {
    layer.sort((a, b) => a.page - b.page);
    const pending = `${outPdfPath}.pending.pdf`;
    try {
      await (writer ?? writeTextLayer)({ pdfPath, outPdfPath: pending, pages: layer, workDir, signal });
      if ((await pdfHasTextLayer(pending)) !== true) throw new Error("the copy has no readable text layer");
      if (signal?.aborted) throw new ExtractAbortedError();
      await rename(pending, outPdfPath);
      searchableCopy = true;
    } catch (err) {
      if (err instanceof ExtractAbortedError || signal?.aborted) throw new ExtractAbortedError();
      await log(`No searchable copy for the AI's reading — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await rm(pending, { force: true }).catch(() => {});
      await rm(`${pending}.part`, { force: true }).catch(() => {});
    }
  }
  if (requireCopy && !searchableCopy) throw new Error("Could not replace the searchable PDF; the previous copy and layout are kept. Check the OCR log and retry placement.");
  await writeLayout(outDir, joined, model, meanPlaced, doubtful);
  const geometryPdf = searchableCopy && outPdfPath ? outPdfPath : pdfPath;
  const fingerprint = await stat(geometryPdf);
  const outputSizes = await pdfPageSizes(geometryPdf);
  geometry.forEach((page, i) => { page.rot = outputSizes[i]?.rotation ?? 0; });
  const native: SourceGeometry = { version: 4, pages: geometry, pdf: { path: geometryPdf, size: fingerprint.size, mtimeMs: fingerprint.mtimeMs } };
  const geometryPath = path.join(outDir, OCR_GEOMETRY_FILE);
  await writeFile(`${geometryPath}.part`, JSON.stringify(native));
  await rename(`${geometryPath}.part`, geometryPath);
  return { joined, meanPlaced, searchableCopy };
}

export type ReplaceStats = { pages: number; meanPlaced: number | null; searchableCopy: boolean };

// Places the saved transcription again — new readers, a better alignment — with no model call,
// and rewrites the layout and the copy. The chapters cut from the old layout keep their text; the
// caller refreshes their block polygons from the new one.
export async function replaceWords(input: Omit<LlmOcrInput, "modelKey">, deps: { reference?: ReferenceReader; writeTextLayer?: TextLayerWriter } = {}): Promise<ReplaceStats> {
  const saved = await readSavedPages(input.outDir);
  if (!saved) throw new Error("No saved AI transcription for this file — read it with the AI engine again first");
  if (!saved.complete) throw new Error("The saved AI transcription is incomplete — read the file with the AI engine again first");
  return withPreparedPages(input, deps.reference, async ({ sizes, images, reference }) => {
    const { pdfPath, outDir, outPdfPath, workDir, log, signal } = input;
    if (saved.pages.length !== sizes.length) throw new Error(`The saved transcription has ${saved.pages.length} pages, the PDF ${sizes.length}`);
    const pages = [...saved.pages];
    const placedShares: (number | null)[] = pages.map(() => null);
    const doubtful: Record<number, string[]> = {};
    const layer: TextLayerPage[] = [];
    const geometry: GeometryPage[] = sizes.map((size, i) => placeOcrPage([], null, size, i).geometry);
    await log(`Placing the AI's words on ${sizes.length} page${sizes.length === 1 ? "" : "s"} again`);
    await pool(images, CONCURRENCY, async (image, i) => {
      const page = pages[i];
      if (!page) return;
      const ref = await reference(image, i + 1);
      const size = sizes[i];
      if (!size) throw new Error(`No dimensions for page ${i + 1}`);
      const placement = placePage(page, ref, size, i);
      geometry[i] = placement.geometry;
      pages[i] = placement.page;
      placedShares[i] = placement.placed;
      if (placement.words.length) layer.push({ page: i + 1, words: placement.words });
      if (placement.doubtful.length) doubtful[i + 1] = placement.doubtful;
    });
    if (signal?.aborted) throw new ExtractAbortedError();
    // A machine with no reader must not trade the copy and polygons it has for nothing
    if (layer.length === 0 && pages.some((p) => p?.blocks.length)) throw new Error("No local reader could place the AI's words on this machine — the layout and the searchable copy are unchanged");
    const { meanPlaced, searchableCopy } = await writeOutputs({ pdfPath, outDir, outPdfPath, workDir, pages, layer, geometry, placedShares, doubtful, model: saved.model, writer: deps.writeTextLayer, requireCopy: Boolean(outPdfPath), log, signal });
    return { pages: sizes.length, meanPlaced, searchableCopy };
  });
}

async function writeLayout(outDir: string, pages: (LlmPage | null)[], model: string, placed: number | null, doubtful: Record<number, string[]>): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, LLM_LAYOUT_FILE), JSON.stringify(toMarkerJson(pages)));
  await writeFile(path.join(outDir, LLM_LAYOUT_META_FILE), JSON.stringify({ engine: "llm", model, pages: pages.length, placed, doubtful, writtenAt: new Date().toISOString() }));
}

export async function hasLlmLayout(outDir: string): Promise<boolean> {
  const files = await readdir(outDir).catch(() => [] as string[]);
  return files.includes(LLM_LAYOUT_FILE) && files.includes(LLM_LAYOUT_META_FILE);
}

// Marker runs into the same outDir; a stale AI layout at the top level would otherwise be the one
// findMarkerJson picks after the engine is switched back.
export async function removeLlmLayout(outDir: string): Promise<void> {
  await rm(path.join(outDir, LLM_LAYOUT_FILE), { force: true }).catch(() => {});
  await rm(path.join(outDir, LLM_LAYOUT_META_FILE), { force: true }).catch(() => {});
  await rm(path.join(outDir, LLM_PAGES_FILE), { force: true }).catch(() => {});
}

export async function runLlmOcr(input: LlmOcrInput): Promise<LlmOcrStats> {
  const { model, def } = await resolveLlm(input.modelKey);
  return makeLlmOcrRunner({ transcribe: makeLlmTranscriber(model, def), modelLabel: def.label })(input);
}
