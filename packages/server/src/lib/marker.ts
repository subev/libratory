import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { env } from "../env.ts";
import { describeError } from "./errors.ts";
import { detectChaptersWithLlm } from "./toc-detect.ts";
import { readCapabilities } from "./model-bundles.ts";

const CONDA_BIN = env.CONDA_ENV_PATH;

type MarkerBlock = {
  id: string;
  block_type: string;
  html: string;
  children: MarkerBlock[] | null;
  section_hierarchy: Record<string, string> | null;
  polygon?: number[][];
};

type MarkerTocEntry = {
  title: string;
  heading_level: number;
  page_id: number;
};

type MarkerOutput = {
  children: MarkerBlock[];
  block_type: "Document";
  metadata?: {
    table_of_contents: MarkerTocEntry[];
  };
};

export type SourceBlock = {
  type: string;
  text: string;
  page: number;
  included: boolean;
  level?: number;
  polygon?: number[][];
};

export type ExtractedChapter = {
  title: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  sourceBlocks: SourceBlock[];
};

export type ChapterDetectionMethod = "llm" | "numbered-headings" | "heading-levels" | "word-split";

export type DetectionResult = {
  chapters: ExtractedChapter[];
  method: ChapterDetectionMethod;
};

const KEEP_BLOCK_TYPES = new Set([
  "Text",
  "SectionHeader",
  "ListItem",
  "Handwriting",
]);

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export type FlatBlock = {
  type: string;
  text: string;
  hierarchy: Record<string, string> | null;
  level?: number;
  page: number;
  polygon?: number[][];
  included: boolean;
};

function collectAllBlocks(block: MarkerBlock, page: number, out: FlatBlock[]) {
  if (block.children) {
    for (const child of block.children) {
      collectAllBlocks(child, page, out);
    }
  } else {
    const text = stripHtml(block.html);
    if (!text) return;
    const included = KEEP_BLOCK_TYPES.has(block.block_type);
    const level = block.block_type === "SectionHeader" ? (extractHeadingLevel(block.html) ?? undefined) : undefined;
    out.push({
      type: block.block_type,
      text,
      hierarchy: block.section_hierarchy,
      level,
      page,
      polygon: block.polygon,
      included,
    });
  }
}

function extractHeadingLevel(html: string): number | null {
  const match = html.match(/<h(\d)/);
  return match ? parseInt(match[1], 10) : null;
}

function blocksToSourceBlocks(blocks: FlatBlock[]): SourceBlock[] {
  return blocks.map((b) => ({
    type: b.type,
    text: b.text,
    page: b.page,
    included: b.included,
    ...(b.level !== undefined ? { level: b.level } : {}),
    ...(b.polygon ? { polygon: b.polygon } : {}),
  }));
}

function chapterFromBlocks(title: string, blocks: FlatBlock[]): ExtractedChapter {
  const includedBlocks = blocks.filter((b) => b.included);
  const text = includedBlocks.map((b) => b.text).join("\n\n");
  const allPages = blocks.map((b) => b.page);
  const pageStart = allPages.length > 0 ? Math.min(...allPages) : null;
  const pageEnd = allPages.length > 0 ? Math.max(...allPages) : null;
  return { title, text, pageStart, pageEnd, sourceBlocks: blocksToSourceBlocks(blocks) };
}

function isLikelySubheading(text: string): boolean {
  const t = text.trim();
  if (/^(?:[A-Za-z]|\d+|[IVXivxlcdm]+)\.\s/.test(t)) return true;
  if (/^[a-z]{1,3}\s+[a-z]\.\s/.test(t)) return true;
  return false;
}

function isLikelyFrontOrBackMatter(text: string): boolean {
  const t = text.toLowerCase();
  return [
    "acknowledg",
    "about the author",
    "introduction",
    "preface",
    "table of contents",
    "contents",
    "bibliography",
    "index",
    "glossary",
  ].some((x) => t.includes(x));
}

function pickChapterHeadingIndices(allBlocks: FlatBlock[]): number[] {
  const headingBlocks: { index: number; level: number; text: string; page: number }[] = [];
  for (let i = 0; i < allBlocks.length; i++) {
    if (allBlocks[i].included && allBlocks[i].type === "SectionHeader") {
      headingBlocks.push({
        index: i,
        level: allBlocks[i].level ?? 4,
        text: allBlocks[i].text,
        page: allBlocks[i].page,
      });
    }
  }

  if (headingBlocks.length === 0) return [];

  const totalPages = Math.max(...allBlocks.map((b) => b.page));
  const minChapterPage = totalPages > 80 ? Math.floor(totalPages * 0.08) : 1;

  let bestIndices: number[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const level of [1, 2, 3, 4]) {
    const levelHeadings = headingBlocks.filter((h) => h.level === level);
    if (levelHeadings.length < 2) continue;

    const filtered = levelHeadings.filter((h) => {
      const words = h.text.split(/\s+/).filter(Boolean).length;
      if (h.page < minChapterPage) return false;
      if (words < 3) return false;
      if (isLikelySubheading(h.text)) return false;
      if (isLikelyFrontOrBackMatter(h.text)) return false;
      return true;
    });

    if (filtered.length < 2) continue;

    const count = filtered.length;
    const target = 10;
    const score = -Math.abs(count - target) + (level === 1 ? 0.5 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestIndices = filtered.map((h) => h.index);
    }
  }

  return bestIndices;
}

const CHAPTER_NUMBER_PATTERN = /^(chapter|part|глава|раздел|част)\s+(\d{1,3}|[IVXLCDM]{1,7})\b/i;

function parseChapterNumber(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  const s = raw.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const cur = values[s[i]];
    const next = values[s[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

export function pickNumberedChapterIndices(allBlocks: FlatBlock[]): number[] {
  const matches: { index: number; page: number; num: number; kind: string }[] = [];
  for (let i = 0; i < allBlocks.length; i++) {
    const b = allBlocks[i];
    if (!b.included || b.type !== "SectionHeader") continue;
    const m = CHAPTER_NUMBER_PATTERN.exec(b.text.trim());
    if (m) matches.push({ index: i, page: b.page, num: parseChapterNumber(m[2]), kind: m[1].toLowerCase() });
  }
  if (matches.length < 3) return [];

  // Mixed part/chapter books: the dominant kind is the chapter-level unit
  const byKind = new Map<string, typeof matches>();
  for (const m of matches) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
  const dominant = [...byKind.values()].reduce((a, b) => (b.length > a.length ? b : a));

  // A ToC page lists many chapters on one page; body chapter headings are spread out
  const perPage = new Map<number, number>();
  for (const m of dominant) perPage.set(m.page, (perPage.get(m.page) ?? 0) + 1);
  const body = dominant.filter((m) => (perPage.get(m.page) ?? 0) < 3);

  // Duplicate numbers come from ToC stragglers or endnotes sections; the body
  // copy is the one followed by the most content before the next match
  const contentWords = body.map((m, i) => {
    const end = i + 1 < body.length ? body[i + 1].index : allBlocks.length;
    let words = 0;
    for (let j = m.index + 1; j < end; j++) {
      if (allBlocks[j].included) words += allBlocks[j].text.split(/\s+/).filter(Boolean).length;
    }
    return words;
  });
  const bestByNum = new Map<number, { m: (typeof matches)[number]; words: number }>();
  body.forEach((m, i) => {
    const cur = bestByNum.get(m.num);
    if (!cur || contentWords[i] >= cur.words) bestByNum.set(m.num, { m, words: contentWords[i] });
  });
  const deduped = [...bestByNum.values()].map((x) => x.m).sort((a, b) => a.index - b.index);

  // Longest strictly-increasing run of chapter numbers drops listing stragglers
  const best: number[][] = deduped.map(() => []);
  for (let i = 0; i < deduped.length; i++) {
    best[i] = [i];
    for (let j = 0; j < i; j++) {
      if (deduped[j].num < deduped[i].num && best[j].length + 1 > best[i].length) {
        best[i] = [...best[j], i];
      }
    }
  }
  const increasing = best.reduce((a, b) => (b.length > a.length ? b : a), []);
  if (increasing.length < 3) return [];
  return increasing.map((i) => deduped[i].index);
}

export function sliceChaptersAtIndices(
  allBlocks: FlatBlock[],
  boundaryIndices: number[],
  titleOverrides?: Map<number, string>
): ExtractedChapter[] {
  const sorted = [...new Set(boundaryIndices)].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return [chapterFromBlocks("Full Text", allBlocks)];
  }

  const chapters: ExtractedChapter[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const end = i + 1 < sorted.length ? sorted[i + 1] : allBlocks.length;
    const blocks = allBlocks.slice(start, end);
    const ch = chapterFromBlocks(titleOverrides?.get(start) ?? allBlocks[start].text, blocks);
    if (ch.text.trim()) {
      chapters.push(ch);
    }
  }

  const prefaceBlocks = allBlocks.slice(0, sorted[0]);
  if (prefaceBlocks.length > 0) {
    const ch = chapterFromBlocks("Preface", prefaceBlocks);
    if (ch.text.trim().split(/\s+/).length > 50) {
      chapters.unshift(ch);
    }
  }

  return chapters;
}

export function detectBoundaryIndices(allBlocks: FlatBlock[]): { indices: number[]; method: "numbered-headings" | "heading-levels" } | null {
  const numberedIndices = pickNumberedChapterIndices(allBlocks);
  if (numberedIndices.length >= 3) return { indices: numberedIndices, method: "numbered-headings" };
  const headingIndices = pickChapterHeadingIndices(allBlocks);
  if (headingIndices.length >= 2) return { indices: headingIndices, method: "heading-levels" };
  return null;
}

function detectChaptersFromBlocks(allBlocks: FlatBlock[]): DetectionResult {
  const detected = detectBoundaryIndices(allBlocks);
  if (!detected) {
    return { chapters: splitByWordCount(allBlocks), method: "word-split" };
  }
  return { chapters: sliceChaptersAtIndices(allBlocks, detected.indices), method: detected.method };
}

function splitByWordCount(allBlocks: FlatBlock[], wordsPerChapter = 5000): ExtractedChapter[] {
  const includedBlocks = allBlocks.filter((b) => b.included);
  const totalWords = includedBlocks.reduce((sum, b) => sum + b.text.split(/\s+/).filter(Boolean).length, 0);

  if (totalWords <= wordsPerChapter) {
    return [chapterFromBlocks("Full Text", allBlocks)];
  }

  const chapters: ExtractedChapter[] = [];
  let partNum = 1;
  let currentBlocks: FlatBlock[] = [];
  let currentWords = 0;

  for (const block of allBlocks) {
    currentBlocks.push(block);
    if (block.included) {
      currentWords += block.text.split(/\s+/).filter(Boolean).length;
    }
    if (currentWords >= wordsPerChapter) {
      chapters.push(chapterFromBlocks(`Part ${partNum}`, currentBlocks));
      partNum++;
      currentBlocks = [];
      currentWords = 0;
    }
  }

  if (currentBlocks.length > 0) {
    chapters.push(chapterFromBlocks(`Part ${partNum}`, currentBlocks));
  }

  return chapters;
}

type LogFn = (message: string) => Promise<void>;

const noopLog: LogFn = async () => {};

export class ExtractAbortedError extends Error {
  constructor() {
    super("Extraction cancelled");
    this.name = "ExtractAbortedError";
  }
}

function runMarkerSingle(pdfPath: string, outDir: string, device: "mps" | "cuda" | "cpu", log: LogFn, forceOcr: boolean, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExtractAbortedError());
      return;
    }

    // Marker decides for itself whether a page needs OCR, and a page carrying any text layer at
    // all counts as good — a phone photo printed to PDF brings the print headers along, which is
    // enough for it to skip the picture entirely. Forcing it means discarding that layer.
    const args = [pdfPath, "--output_format", "json", "--output_dir", outDir];
    args.push(forceOcr ? "--force_ocr" : "--disable_ocr");
    const proc = spawn(
      path.join(CONDA_BIN, "marker_single"),
      args,
      { env: { ...process.env, TORCH_DEVICE: device, HF_HUB_OFFLINE: "1", OMP_NUM_THREADS: String(os.availableParallelism()), MKL_NUM_THREADS: String(os.availableParallelism()), PATH: `${CONDA_BIN}:${process.env.PATH}` } }
    );

    const handleAbort = () => proc.kill("SIGKILL");
    signal?.addEventListener("abort", handleAbort, { once: true });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("marker_single timed out after 24 hours"));
    }, 86_400_000);

    let lastStage = "";
    let lastLoggedPercent = -1;
    let lastLogTime = Date.now();
    const rl = createInterface({ input: proc.stderr });
    rl.on("line", (line) => {
      const progressMatch = line.match(/(\d+)\/(\d+)/);
      if (progressMatch) {
        const [, currentStr, totalStr] = progressMatch;
        const current = Number(currentStr);
        const total = Number(totalStr);
        const stage = line.trim().split(":")[0]?.trim() || "Processing";
        const percent = total > 0 ? Math.floor((current / total) * 100) : 0;
        const isNewStage = stage !== lastStage;
        const isSignificantProgress = percent >= lastLoggedPercent + 1;
        const isComplete = current === total;
        const isSilenceTooLong = Date.now() - lastLogTime >= 30_000;

        if (isNewStage || isSignificantProgress || isComplete || isSilenceTooLong) {
          log(`${stage}: ${currentStr}/${totalStr}`);
          lastStage = stage;
          lastLoggedPercent = percent;
          lastLogTime = Date.now();
        }
        if (isNewStage) lastLoggedPercent = percent;
      } else if (line.includes("TableRecEncoderDecoderModel")) {
        // Benign: surya hard-pins table-rec to CPU on MPS (datalab-to/marker#827); everything else stays on MPS
      } else if (line.includes("WARNING") || line.includes("Error") || line.includes("Traceback")) {
        log(line.trim());
      }
    });

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      rl.close();
      signal?.removeEventListener("abort", handleAbort);
      if (signal?.aborted) {
        reject(new ExtractAbortedError());
      } else if (code !== 0) {
        reject(new Error(`marker_single exited with code ${code}`));
      } else {
        resolve();
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      rl.close();
      signal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}

export type ExtractOptions = {
  forceOcr?: boolean;
  llmChapterDetection?: boolean;
  chapterModel?: string;
  signal?: AbortSignal;
};

export async function findMarkerJson(outDir: string): Promise<string> {
  let searchDir = outDir;
  const files = await readdir(outDir);
  let jsonFile = files.find((f) => f.endsWith(".json") && !f.endsWith("_meta.json"));

  if (!jsonFile) {
    for (const entry of files) {
      const entryPath = path.join(outDir, entry);
      const s = await stat(entryPath);
      if (!s.isDirectory()) continue;
      const subFiles = await readdir(entryPath);
      const found = subFiles.find((f) => f.endsWith(".json") && !f.endsWith("_meta.json"));
      if (!found) continue;
      searchDir = entryPath;
      jsonFile = found;
      break;
    }
  }

  if (!jsonFile) {
    throw new Error("Marker did not produce a JSON output file");
  }

  return path.join(searchDir, jsonFile);
}

async function collectBlocksFromMarkerJson(markerJsonPath: string): Promise<FlatBlock[]> {
  const raw = await readFile(markerJsonPath, "utf-8");
  const doc: MarkerOutput = JSON.parse(raw);

  const allBlocks: FlatBlock[] = [];

  for (let pageIdx = 0; pageIdx < doc.children.length; pageIdx++) {
    const page = doc.children[pageIdx];
    if (page.block_type !== "Page" || !page.children) continue;
    const pageNum = pageIdx + 1;
    for (const block of page.children) {
      if (block.children) {
        collectAllBlocks(block, pageNum, allBlocks);
      } else {
        const text = stripHtml(block.html);
        if (!text) continue;
        const included = KEEP_BLOCK_TYPES.has(block.block_type);
        const level = block.block_type === "SectionHeader" ? (extractHeadingLevel(block.html) ?? undefined) : undefined;
        allBlocks.push({
          type: block.block_type,
          text,
          hierarchy: block.section_hierarchy,
          level,
          page: pageNum,
          polygon: block.polygon,
          included,
        });
      }
    }
  }

  return allBlocks;
}

export async function collectBlocksFromMarkerOutput(outDir: string): Promise<FlatBlock[]> {
  return collectBlocksFromMarkerJson(await findMarkerJson(outDir));
}

async function detectChaptersFromMarkerJsonPath(markerJsonPath: string, pdfPath: string, log: LogFn, options: ExtractOptions): Promise<DetectionResult> {
  const allBlocks = await collectBlocksFromMarkerJson(markerJsonPath);

  if (options.llmChapterDetection) {
    try {
      const selected = await detectChaptersWithLlm([{ fileIndex: null, blocks: allBlocks, pdfPath }], log, { model: options.chapterModel });
      const selections = selected?.get(null) ?? [];
      if (selections.length >= 2) {
        const titles = new Map(selections.filter((s) => s.title).map((s) => [s.blockIndex, s.title!]));
        const chapters = sliceChaptersAtIndices(allBlocks, selections.map((s) => s.blockIndex), titles);
        if (chapters.length >= 2) return { chapters, method: "llm" };
      }
      await log("AI chapter detection returned no usable chapters, falling back to heuristic");
    } catch (err) {
      await log(`AI chapter detection failed: ${describeError(err)} — falling back to heuristic`);
    }
  }

  return detectChaptersFromBlocks(allBlocks);
}

export async function extractPdf(pdfPath: string, outDir: string, log: LogFn = noopLog, options: ExtractOptions = {}): Promise<DetectionResult> {
  await mkdir(outDir, { recursive: true });

  const forceOcr = options.forceOcr ?? false;
  await log(`Running marker_single on "${path.basename(pdfPath)}"${forceOcr ? " (forcing OCR)" : " (OCR disabled)"}`);

  // A Mac starts on Metal. Elsewhere the capabilities probe answers whether torch can see CUDA —
  // letting marker guess would spend the first half-hour attempt finding out the hard way.
  const capabilities = process.platform === "darwin" ? null : await readCapabilities().catch(() => null);
  const firstDevice = process.platform === "darwin" ? "mps" : capabilities?.cuda ? "cuda" : "cpu";
  try {
    await runMarkerSingle(pdfPath, outDir, firstDevice, log, forceOcr, options.signal);
  } catch (deviceError) {
    if (deviceError instanceof ExtractAbortedError) throw deviceError;
    // Only a non-CPU failure gets a second chance: the MPS bug is real, and a CUDA install can be
    // broken in ways a book upload should not have to care about. A CPU failure is the real thing.
    if (firstDevice === "cpu") throw deviceError;
    await log(firstDevice === "mps"
      ? `MPS extraction failed — known PyTorch MPS bug with certain PDFs. Retrying with CPU...`
      : `CUDA extraction failed. Retrying with CPU...`);
    await runMarkerSingle(pdfPath, outDir, "cpu", log, forceOcr, options.signal);
  }

  if (options.signal?.aborted) throw new ExtractAbortedError();
  const markerJsonPath = await findMarkerJson(outDir);
  const result = await detectChaptersFromMarkerJsonPath(markerJsonPath, pdfPath, log, options);
  if (options.signal?.aborted) throw new ExtractAbortedError();
  return result;
}

export async function redetectChaptersFromExistingMarkerOutput(outDir: string, pdfPath: string, log: LogFn = noopLog, options: ExtractOptions = {}): Promise<DetectionResult> {
  const markerJsonPath = await findMarkerJson(outDir);
  await log("Re-detecting chapters from existing Marker output");
  return detectChaptersFromMarkerJsonPath(markerJsonPath, pdfPath, log, options);
}
