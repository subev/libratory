import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FlatBlock } from "./marker.ts";
import { llmChat } from "./llm.ts";
import { describeError } from "./errors.ts";

const execFileAsync = promisify(execFile);

export type TocEntry = { title: string; page: number | null };
export type TocResult = { found: boolean; tocPages: number[]; entries: TocEntry[] };
export type HeadingCatalogEntry = { id: string; blockIndex: number; page: number; level: number | null; text: string };
export type PageWindow = { pages: number[]; entries: { page: number; text: string }[]; text: string };
export type HeadingSelection = { blockIndex: number; title: string | null; titleTranslated: string | null };

const WINDOW_PAGES = 15;
const MAX_PAGE_CHARS = 6000;
const MAX_WINDOW_CHARS = 60_000;
const MAX_CATALOG_ENTRIES = 1500;
const MAX_TOC_ENTRIES = 400;

export function buildPageWindow(blocks: FlatBlock[], side: "head" | "tail", count = WINDOW_PAGES): PageWindow {
  const allPages = [...new Set(blocks.map((b) => b.page))].sort((a, b) => a - b);
  const pages = side === "head" ? allPages.slice(0, count) : allPages.slice(-count);
  const wanted = new Set(pages);

  const byPage = new Map<number, string[]>();
  for (const b of blocks) {
    if (!wanted.has(b.page)) continue;
    let texts = byPage.get(b.page);
    if (!texts) byPage.set(b.page, (texts = []));
    texts.push(b.text);
  }

  const parts: string[] = [];
  const entries: { page: number; text: string }[] = [];
  let total = 0;
  for (const page of pages) {
    const text = (byPage.get(page) ?? []).join("\n").slice(0, MAX_PAGE_CHARS);
    const part = `p${page}:\n${text}`;
    if (total + part.length > MAX_WINDOW_CHARS && entries.length > 0) break;
    parts.push(part);
    entries.push({ page, text });
    total += part.length;
  }
  return { pages: entries.map((e) => e.page), entries, text: parts.join("\n\n") };
}

async function readPdfPageText(pdfPath: string, page: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "pdftotext",
      [pdfPath, "-", "-f", String(page), "-l", String(page)],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const text = stdout.replace(/\s+/g, " ").trim();
    return text || null;
  } catch {
    return null;
  }
}

// Per page, keep whichever text has more content. The raw layer survives regions
// marker's layout model drops (dot-leader TOC pages especially); marker's own OCR is
// the only text at all for image-only scans, where the layer comes back empty.
export function mergePageTexts(
  entries: { page: number; text: string }[],
  layerByPage: Map<number, string>
): string {
  const parts: string[] = [];
  let total = 0;
  for (const { page, text } of entries) {
    const layer = layerByPage.get(page) ?? "";
    const best = (layer.length > text.length ? layer : text).slice(0, MAX_PAGE_CHARS);
    const part = `p${page}:\n${best}`;
    if (total + part.length > MAX_WINDOW_CHARS && parts.length > 0) break;
    parts.push(part);
    total += part.length;
  }
  return parts.join("\n\n");
}

async function buildTocWindowText(window: PageWindow, pdfPath: string | undefined): Promise<string> {
  if (!pdfPath) return window.text;
  const layerByPage = new Map<number, string>();
  for (const { page } of window.entries) {
    const layer = await readPdfPageText(pdfPath, page);
    if (layer) layerByPage.set(page, layer);
  }
  return mergePageTexts(window.entries, layerByPage);
}

export function buildHeadingCatalog(blocks: FlatBlock[], excludePages: Set<number> = new Set()): HeadingCatalogEntry[] {
  const catalog: HeadingCatalogEntry[] = [];
  for (const [i, b] of blocks.entries()) {
    if (!b.included || b.type !== "SectionHeader" || excludePages.has(b.page)) continue;
    if (catalog.length >= MAX_CATALOG_ENTRIES) break;
    catalog.push({
      id: `h_${String(i).padStart(4, "0")}`,
      blockIndex: i,
      page: b.page,
      level: b.level ?? null,
      text: b.text,
    });
  }
  return catalog;
}

export function buildTocPrompt(frontText: string, backText: string): { system: string; user: string } {
  return {
    system: "You analyze extracted pages from a book to locate its printed table of contents.",
    user: [
      "Below are the first and last pages of a book as extracted text (p<N> = PDF page number). The text may be OCR output with errors.",
      'Find the printed table of contents: a list of chapter or section titles, usually with page numbers, often titled "Contents", "Table of Contents", "Оглавление", "Съдържание", or similar. It may span several pages and may be at the front or the back of the book.',
      "Return JSON only, in this shape:",
      '{"found": true, "tocPages": [PDF page numbers the table of contents appears on], "entries": [{"title": "chapter title as printed", "page": printed page number or null}]}',
      'List entries in the order they appear. Use null when a page number is missing or unreadable. If there is no table of contents, return {"found": false, "tocPages": [], "entries": []}.',
      `FRONT PAGES:\n${frontText}`,
      `BACK PAGES:\n${backText}`,
    ].join("\n\n"),
  };
}

export function buildSelectionPrompt(
  toc: TocResult | null,
  catalog: HeadingCatalogEntry[],
  opts: { feedback?: string; translateTo?: string } = {}
): { system: string; user: string } {
  const tocSection = toc && toc.found && toc.entries.length > 0
    ? "TABLE OF CONTENTS (extracted from the book, may contain OCR errors):\n" +
      toc.entries.slice(0, MAX_TOC_ENTRIES).map((e) => `- "${e.title}" (p. ${e.page ?? "?"})`).join("\n")
    : "No table of contents was found in this book. Use your best judgment based on the heading catalog alone.";

  const catalogLines = catalog.map((h) => `${h.id} p${h.page} l${h.level ?? "?"} "${h.text}"`);

  return {
    system: "You select audiobook chapter boundaries from a book's known headings.",
    user: [
      "Select the headings that start the book's top-level chapters.",
      tocSection,
      "HEADING CATALOG (id, PDF page, heading level, text):\n" + catalogLines.join("\n"),
      [
        "Rules:",
        "- A chapter is a unit a listener would navigate to in an audiobook. Aim for one selected heading per chapter-like table-of-contents entry.",
        "- In collections (tales, stories, essays, letters), EACH numbered story or piece is its own chapter. Parts and volumes are grouping labels: when a part contains chapters, select the chapters, not just the part heading.",
        "- Also select significant front/back matter (introduction, preface, epilogue, acknowledgments) when the table of contents lists it.",
        '- Do NOT select subsections inside a chapter, sub-questions, exercises, or repeated in-chapter headings (e.g. "Practice Questions", "Answers").',
        "- Printed page numbers in the table of contents may be offset from PDF page numbers by a roughly constant amount.",
        "- Titles may be garbled by OCR — match table-of-contents entries to headings by meaning and position, not exact spelling.",
        "- Only choose ids that appear in the heading catalog. Do not invent ids.",
        "- For each selected heading, provide a clean, readable chapter title: fix OCR artifacts, broken spacing, and casing; prefer the table-of-contents wording when it is cleaner. Keep the book's original language — do not translate the title.",
        ...(opts.translateTo
          ? [`- Also provide "translated": the cleaned title translated into ${opts.translateTo}.`]
          : []),
      ].join("\n"),
      ...(opts.feedback ? [`IMPORTANT: ${opts.feedback}`] : []),
      opts.translateTo
        ? `Return JSON only: {"selections": [{"id": "h_0001", "title": "clean chapter title", "translated": "title in ${opts.translateTo}"}, ...]} with the selections in reading order.`
        : 'Return JSON only: {"selections": [{"id": "h_0001", "title": "clean chapter title"}, ...]} with the selections in reading order.',
    ].join("\n\n"),
  };
}

// Printed page numbers come back as numbers, digit strings, or roman numerals ("xv" → null)
function parsePageNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return parseInt(value, 10);
  return null;
}

function stripJsonFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export function parseTocResponse(response: string): TocResult | null {
  const stripped = stripJsonFences(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Salvage JSON wrapped in prose (reasoning models occasionally narrate around it)
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const tocPages = Array.isArray(obj.tocPages)
    ? obj.tocPages.filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0)
    : [];
  const entries: TocEntry[] = [];
  if (Array.isArray(obj.entries)) {
    for (const e of obj.entries) {
      if (typeof e !== "object" || e === null) continue;
      const title = typeof (e as Record<string, unknown>).title === "string" ? ((e as Record<string, unknown>).title as string).trim() : "";
      if (!title) continue;
      entries.push({ title, page: parsePageNumber((e as Record<string, unknown>).page) });
    }
  }
  return { found: obj.found === true && entries.length > 0, tocPages, entries };
}

export function parseSelectionResponse(response: string, catalog: HeadingCatalogEntry[]): HeadingSelection[] | null {
  const byId = new Map(catalog.map((h) => [h.id, h.blockIndex]));
  const picked = new Map<number, { title: string | null; titleTranslated: string | null }>();

  const clean = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const add = (id: unknown, title: unknown, translated: unknown) => {
    if (typeof id !== "string" || !byId.has(id)) return;
    const blockIndex = byId.get(id)!;
    const entry = { title: clean(title), titleTranslated: clean(translated) };
    if (!picked.has(blockIndex) || (entry.title && !picked.get(blockIndex)!.title)) picked.set(blockIndex, entry);
  };

  try {
    const parsed = JSON.parse(stripJsonFences(response));
    const obj = parsed as Record<string, unknown>;
    const selections = Array.isArray(obj?.selections) ? obj.selections : null;
    if (selections) {
      for (const s of selections) {
        if (typeof s === "object" && s !== null) {
          const rec = s as Record<string, unknown>;
          add(rec.id, rec.title, rec.translated);
        } else add(s, null, null);
      }
    } else {
      const rawIds = Array.isArray(parsed) ? parsed : obj?.ids;
      if (Array.isArray(rawIds)) for (const id of rawIds) add(id, null, null);
    }
  } catch {
    // fall through to regex extraction
  }
  if (picked.size === 0) {
    for (const id of response.match(/h_\d+/g) ?? []) add(id, null, null);
  }

  const selections = [...picked.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([blockIndex, entry]) => ({ blockIndex, ...entry }));
  if (catalog.length > 20 && selections.length >= 0.95 * catalog.length) return null;
  return selections;
}

type LogFn = (message: string) => Promise<void>;
type SourceBlocks = { fileIndex: number | null; blocks: FlatBlock[]; pdfPath?: string };

// No maxTokens: deepseek-v4-flash spends its budget on reasoning first and a cap
// can leave zero tokens for content (finish_reason "length", empty response).
// Long timeout for the same reason — reasoning over a whole TOC can take minutes.
// Low reasoning effort: TOC extraction and heading selection are structured tasks, and
// local models decode slowly — full-depth thinking blows the timeout (ignored by cloud APIs)
const CHAT_OPTS = { temperature: 0.3, responseFormat: "json_object" as const, timeoutMs: 600_000, reasoningEffort: "low" as const };

export async function detectChaptersWithLlm(
  files: SourceBlocks[],
  log: LogFn,
  opts: { translateTo?: string; model?: string } = {}
): Promise<Map<number | null, HeadingSelection[]> | null> {
  const chatOpts = { ...CHAT_OPTS, model: opts.model };
  const selected = new Map<number | null, HeadingSelection[]>();
  let total = 0;
  let lastError: unknown = null;

  // Each file is typically its own volume with its own printed TOC
  for (const { fileIndex, blocks, pdfPath } of files) {
    const where = files.length > 1 ? ` in file ${fileIndex ?? 0}` : "";
    const front = buildPageWindow(blocks, "head");
    const back = buildPageWindow(blocks, "tail");
    await log(`[AI] Reading the first/last pages${where} to find a table of contents (takes a minute or two)...`);
    const tocPrompt = buildTocPrompt(
      await buildTocWindowText(front, pdfPath),
      await buildTocWindowText(back, pdfPath)
    );

    // TOC evidence is best-effort — a failed call degrades to headings-alone selection
    let toc: TocResult | null = null;
    let tocCallError: string | null = null;
    try {
      toc = parseTocResponse(await llmChat(tocPrompt.system, tocPrompt.user, chatOpts));
    } catch (err) {
      tocCallError = describeError(err);
    }

    if (toc?.found) {
      await log(`[AI] Found table of contents on page(s) ${toc.tocPages.join(", ") || "?"}${where}: ${toc.entries.length} entries`);
    } else if (tocCallError) {
      await log(`[AI] Table-of-contents call failed${where} (${tocCallError}), selecting from headings alone`);
    } else if (toc === null) {
      await log(`[AI] Table-of-contents response was not valid JSON${where}, selecting from headings alone`);
    } else {
      await log(`[AI] No table of contents found${where}, selecting from headings alone`);
    }

    const tocPageSet = new Set(toc?.tocPages ?? []);
    const excludePages = new Set([...front.pages, ...back.pages].filter((p) => tocPageSet.has(p)));

    const catalog = buildHeadingCatalog(blocks, excludePages);
    if (catalog.length === 0) {
      await log(`[AI] No headings${where}, skipping`);
      continue;
    }

    await log(`[AI] Choosing chapter starts among ${catalog.length} headings${where} (takes a few minutes)...`);
    let selections: HeadingSelection[] | null = null;
    try {
      const prompt = buildSelectionPrompt(toc, catalog, { translateTo: opts.translateTo });
      selections = parseSelectionResponse(await llmChat(prompt.system, prompt.user, chatOpts), catalog);

      // Conservative selections (e.g. only front matter) get one corrective retry.
      // Fall back to the full entry count when OCR left most TOC page numbers unreadable.
      const paged = toc?.found ? toc.entries.filter((e) => e.page !== null).length : 0;
      const expected = toc?.found ? (paged >= 10 ? paged : toc.entries.length) : 0;
      if (selections !== null && expected >= 10 && selections.length < expected / 3) {
        await log(`[AI] Only ${selections.length} headings selected vs ${expected} table-of-contents entries${where}, retrying with feedback`);
        const retry = buildSelectionPrompt(toc, catalog, {
          translateTo: opts.translateTo,
          feedback: `A previous attempt selected only ${selections.length} headings, far fewer than the ${expected} entries in the table of contents. Most of those entries are chapters — select a heading for each of them.`,
        });
        const retried = parseSelectionResponse(await llmChat(retry.system, retry.user, chatOpts), catalog);
        if (retried !== null && retried.length > selections.length) selections = retried;
      }
    } catch (err) {
      lastError = err;
      await log(`[AI] Selection call failed${where}: ${describeError(err)}`);
      continue;
    }

    if (selections === null) {
      await log(`[AI] Selection covered nearly all ${catalog.length} headings${where}, treating as failure`);
      continue;
    }
    await log(`[AI] Selected ${selections.length} of ${catalog.length} headings${where}`);
    selected.set(fileIndex, selections);
    total += selections.length;
  }

  // A proposal with nothing but errors should fail visibly, not report "no chapters"
  if (selected.size === 0 && lastError) throw lastError;
  return total >= 2 ? selected : null;
}
