import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FlatBlock } from "./marker.ts";
import type { ChapterProposalToc } from "../schema.ts";
import { llmChat, type LlmChatOptions } from "./llm.ts";
import { describeError } from "./errors.ts";
import {
  buildPageMap,
  cumulativeWords,
  findAnchors,
  locateEntries,
  type ChapterEntry,
  type HeadingCatalogEntry,
  type TocEntry,
  type Unresolved,
} from "./toc-anchor.ts";

const execFileAsync = promisify(execFile);

export type TocResult = { found: boolean; tocPages: number[]; entries: TocEntry[] };
export type PageWindow = { pages: number[]; entries: { page: number; text: string }[]; text: string };
export type HeadingSelection = { blockIndex: number; title: string | null; titleTranslated: string | null };
export type LlmDetection = { selected: Map<number | null, HeadingSelection[]>; toc: ChapterProposalToc[] };

type ChosenEntry = { i: number; title: string; translated: string | null };

const WINDOW_PAGES = 15;
const MAX_PAGE_CHARS = 6000;
const MAX_WINDOW_CHARS = 60_000;
const MAX_TOC_ENTRIES = 400;
const MIN_TOC_ENTRIES = 2;

// Spans the page range, not just pages with blocks: marker often produces nothing for the TOC page itself
export function buildPageWindow(blocks: FlatBlock[], side: "head" | "tail", count = WINDOW_PAGES): PageWindow {
  const pageNumbers = blocks.map((b) => b.page);
  const first = pageNumbers.length > 0 ? Math.min(...pageNumbers) : 1;
  const last = pageNumbers.length > 0 ? Math.max(...pageNumbers) : 0;
  const allPages = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
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

// Leading spaces are the TOC hierarchy; the padding before page numbers is not
export function layoutText(raw: string): string {
  return raw
    .replace(/\f/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, "").replace(/(\S) {3,}/g, "$1  "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readPdfPageText(pdfPath: string, page: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "pdftotext",
      ["-layout", "-f", String(page), "-l", String(page), pdfPath, "-"],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
    );
    return layoutText(stdout) || null;
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
  const dense = (s: string) => s.replace(/\s+/g, "").length;
  const parts: string[] = [];
  let total = 0;
  for (const { page, text } of entries) {
    const layer = layerByPage.get(page) ?? "";
    const best = (dense(layer) > dense(text) ? layer : text).slice(0, MAX_PAGE_CHARS);
    const part = `p${page}:\n${best}`;
    if (total + part.length > MAX_WINDOW_CHARS && parts.length > 0) break;
    parts.push(part);
    total += part.length;
  }
  return parts.join("\n\n");
}


export function buildHeadingCatalog(blocks: FlatBlock[], excludePages: Set<number> = new Set()): HeadingCatalogEntry[] {
  const cum = cumulativeWords(blocks);
  const catalog: HeadingCatalogEntry[] = [];
  for (const [i, b] of blocks.entries()) {
    if (!b.included || b.type !== "SectionHeader" || excludePages.has(b.page)) continue;
    catalog.push({
      id: `h_${String(i).padStart(4, "0")}`,
      blockIndex: i,
      page: b.page,
      level: b.level ?? null,
      text: b.text,
      words: 0,
    });
  }
  for (const [k, h] of catalog.entries()) {
    const next = catalog[k + 1];
    h.words = (next ? cum.before[next.blockIndex] ?? cum.total : cum.total) - (cum.before[h.blockIndex] ?? 0);
  }
  return catalog;
}

function catalogLine(h: HeadingCatalogEntry, withLevel = true): string {
  return `${h.id} p${h.page}${withLevel ? ` l${h.level ?? "?"}` : ""} +${h.words}w "${h.text}"`;
}

export function buildTocPrompt(frontText: string, backText: string): { system: string; user: string } {
  return {
    system: "You analyze extracted pages from a book to locate its printed table of contents.",
    user: [
      "Below are the first and last pages of a book as text extracted with the page layout preserved (p<N> = PDF page number). Indentation is meaningful: in a table of contents, deeper indentation means a lower level (part, then chapter, then section). The text may be OCR output with errors.",
      'Find the printed table of contents: a list of chapter or section titles, usually with page numbers, often titled "Contents", "Table of Contents", "Оглавление", "Съдържание", or similar. It may span several pages and may be at the front or the back of the book.',
      "Return JSON only, in this shape:",
      '{"found": true, "tocPages": [PDF page numbers the table of contents appears on], "entries": [{"title": "entry title as printed", "page": printed page number or null, "level": indentation depth}]}',
      "level is the indentation depth as printed: 0 for the least indented entries, 1 for entries indented under them, and so on. An entry wrapped over two lines is one entry; its continuation line is indented further and usually carries the page number. Use null when a page number is missing or unreadable (roman numerals too). List entries in printed order; do not include running heads, author/editor/compiler credits, explanatory notes, or the word Contents itself.",
      'If there is no table of contents, return {"found": false, "tocPages": [], "entries": []}.',
      `FRONT PAGES:\n${frontText}`,
      `BACK PAGES:\n${backText}`,
    ].join("\n\n"),
  };
}

export function buildTierPrompt(toc: TocResult, opts: { translateTo?: string; totalPages?: number; totalWords?: number } = {}): { system: string; user: string } {
  const lines = toc.entries.slice(0, MAX_TOC_ENTRIES).map((e, i) => `[${i}] L${e.level ?? "?"} "${e.title}"${e.page !== null ? ` p${e.page}` : ""}`);
  return {
    system: "You decide which table-of-contents entries of a book become audiobook chapters.",
    user: [
      ...(opts.totalPages ? [`The whole book has ${opts.totalPages} PDF pages and approximately ${opts.totalWords ?? "unknown"} words. PDF file boundaries are not chapter boundaries.`] : []),
      "TABLE OF CONTENTS as extracted from the book (L = indentation level, p = printed page; titles may contain OCR errors):\n" + lines.join("\n"),
      [
        "Rules:",
        "- A chapter is a unit a listener would navigate to in an audiobook. Usually one level of the table of contents is the chapter level; use that level consistently through the whole book.",
        "- Parts, books and volumes are grouping labels: when a part contains chapters, select the chapters, not the part. Select a part heading only when it has no chapters of its own.",
        "- Follow the printed contents hierarchy. In collections, select individual pieces only when the contents presents them as chapter-level entries. A category covering many numbered songs, poems, or tales is one chapter when that is how the contents organizes the book; do not expand number ranges into individual chapters.",
        "- Use gaps between printed start pages to judge section lengths relative to the whole book and its typical chapters. Avoid tiny standalone grouping labels immediately followed by their first child, duplicate starts, and isolated fragments. Genuine short chapters explicitly listed in the contents are valid; do not force uniform lengths or invent a fixed duration target.",
        "- Do NOT select sections inside a chapter, even when they have their own page numbers.",
        "- Also select substantial front and back matter a listener would want as its own chapter (introduction, preface, prologue, epilogue, afterword, appendices with prose). Do not select the index, bibliography, notes, or the table of contents itself.",
        "- For each selected entry, give a clean, readable title: fix OCR artifacts, broken spacing, and casing. Keep the book's original language — do not translate the title.",
        ...(opts.translateTo ? [`- Also provide "translated": the cleaned title translated into ${opts.translateTo}.`] : []),
      ].join("\n"),
      opts.translateTo
        ? `Return JSON only: {"chapters": [{"i": 3, "title": "clean chapter title", "translated": "title in ${opts.translateTo}"}, ...]} in table-of-contents order, where i is the entry number in brackets.`
        : 'Return JSON only: {"chapters": [{"i": 3, "title": "clean chapter title"}, ...]} in table-of-contents order, where i is the entry number in brackets.',
    ].join("\n\n"),
  };
}

export function buildResolvePrompt(items: { entry: Unresolved; title: string; printedPage: number | null }[]): { system: string; user: string } {
  const sections = items.map(({ entry, title, printedPage }) => {
    const where = entry.expectedPage !== null ? ` (printed p. ${printedPage ?? "?"}, expected around PDF p. ${entry.expectedPage})` : "";
    return [`ENTRY [${entry.entry}] "${title}"${where}`, ...entry.candidates.map((h) => `  ${catalogLine(h, false)}`)].join("\n");
  });
  return {
    system: "You match table-of-contents entries of a book to the headings found in its PDF.",
    user: [
      "Each entry below is a chapter from the book's table of contents, followed by the headings found near the PDF page where it should start (id, PDF page, words of text that follow the heading, heading text as extracted). Heading text is often garbled by OCR — match by meaning, letter shapes, and position, not exact spelling. A chapter heading is normally followed by substantial text; a heading followed by a handful of words is usually a label or a part-title page.",
      sections.join("\n\n"),
      'Return JSON only: {"matches": [{"i": 3, "id": "h_0511"}, ...]} with one item per entry. Use null for id when none of the listed headings is that entry\'s heading.',
    ].join("\n\n"),
  };
}

export function buildSelectionPrompt(
  toc: TocResult | null,
  catalog: HeadingCatalogEntry[],
  opts: { translateTo?: string } = {}
): { system: string; user: string } {
  const tocSection = toc && toc.found && toc.entries.length > 0
    ? "TABLE OF CONTENTS (extracted from the book, may contain OCR errors):\n" +
      toc.entries.slice(0, MAX_TOC_ENTRIES).map((e) => `- "${e.title}" (p. ${e.page ?? "?"})`).join("\n")
    : "No table of contents was found in this book. Use your best judgment based on the heading catalog alone.";

  return {
    system: "You select audiobook chapter boundaries from a book's known headings.",
    user: [
      "Select the headings that start the book's top-level chapters.",
      tocSection,
      "HEADING CATALOG (id, PDF page, heading level, words of text that follow the heading, text):\n" + catalog.map((h) => catalogLine(h)).join("\n"),
      [
        "Rules:",
        "- A chapter is a unit a listener would navigate to in an audiobook. Aim for one selected heading per chapter-like table-of-contents entry.",
        "- When a table of contents exists, preserve its chapter-level granularity: a heading for a category of songs or tales need not become hundreds of numbered-piece chapters. Without contents, infer a consistent chapter level from the heading hierarchy and relative section lengths.",
        "- Avoid duplicate starts and tiny standalone grouping labels. The +Nw value runs only to the next heading, which may be a subsection; assess chapter length through the next selected chapter. Keep genuine short chapters supported by the contents rather than imposing a fixed length.",
        "- Also select significant front/back matter (introduction, preface, epilogue, acknowledgments) when the table of contents lists it.",
        '- Do NOT select subsections inside a chapter, sub-questions, exercises, or repeated in-chapter headings (e.g. "Practice Questions", "Answers").',
        "- The +Nw figure is how many words follow a heading before the next heading. A chapter start is normally followed by substantial text; a heading followed by a handful of words is usually a label, a running head, or a part-title page.",
        "- Printed page numbers in the table of contents may be offset from PDF page numbers by a roughly constant amount.",
        "- Titles may be garbled by OCR — match table-of-contents entries to headings by meaning and position, not exact spelling.",
        "- Only choose ids that appear in the heading catalog. Do not invent ids.",
        "- For each selected heading, provide a clean, readable chapter title: fix OCR artifacts, broken spacing, and casing; prefer the table-of-contents wording when it is cleaner. Keep the book's original language — do not translate the title.",
        ...(opts.translateTo
          ? [`- Also provide "translated": the cleaned title translated into ${opts.translateTo}.`]
          : []),
      ].join("\n"),
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

function parseJsonObject(response: string): Record<string, unknown> | null {
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

const clean = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

export function parseTocResponse(response: string): TocResult | null {
  const obj = parseJsonObject(response);
  if (!obj) return null;

  const tocPages = Array.isArray(obj.tocPages)
    ? obj.tocPages.filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0)
    : [];
  const entries: TocEntry[] = [];
  if (Array.isArray(obj.entries)) {
    for (const e of obj.entries) {
      if (typeof e !== "object" || e === null) continue;
      const rec = e as Record<string, unknown>;
      const title = clean(rec.title);
      if (!title) continue;
      const level = typeof rec.level === "number" && Number.isInteger(rec.level) && rec.level >= 0 ? rec.level : null;
      entries.push({ title, page: parsePageNumber(rec.page), level });
    }
  }
  return { found: obj.found === true && entries.length > 0, tocPages, entries };
}

export function parseTierResponse(response: string, toc: TocResult): ChosenEntry[] {
  const obj = parseJsonObject(response);
  const list = Array.isArray(obj?.chapters) ? obj.chapters : [];
  const chosen: ChosenEntry[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const i = typeof rec.i === "number" && Number.isInteger(rec.i) ? rec.i : -1;
    const entry = toc.entries[i];
    if (!entry || seen.has(i)) continue;
    seen.add(i);
    chosen.push({ i, title: clean(rec.title) ?? entry.title, translated: clean(rec.translated) });
  }
  return chosen.sort((a, b) => a.i - b.i);
}

export function parseResolveResponse(response: string, unresolved: Unresolved[]): Map<number, number> {
  const matches = new Map<number, number>();
  const obj = parseJsonObject(response);
  const list = Array.isArray(obj?.matches) ? obj.matches : [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const entry = unresolved.find((u) => u.entry === rec.i);
    const heading = entry?.candidates.find((h) => h.id === rec.id);
    if (entry && heading) matches.set(entry.entry, heading.blockIndex);
  }
  return matches;
}

export function parseSelectionResponse(response: string, catalog: HeadingCatalogEntry[]): HeadingSelection[] | null {
  const byId = new Map(catalog.map((h) => [h.id, h.blockIndex]));
  const picked = new Map<number, { title: string | null; titleTranslated: string | null }>();

  const add = (id: unknown, title: unknown, translated: unknown) => {
    if (typeof id !== "string" || !byId.has(id)) return;
    const blockIndex = byId.get(id)!;
    const entry = { title: clean(title), titleTranslated: clean(translated) };
    const existing = picked.get(blockIndex);
    if (!existing || (entry.title && !existing.title)) picked.set(blockIndex, entry);
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

// No maxTokens: DeepSeek Flash spends its budget on reasoning first and a cap
// can leave zero tokens for content (finish_reason "length", empty response).
// Long timeout for the same reason — reasoning over a whole TOC can take minutes.
// Low reasoning effort: TOC extraction and heading selection are structured tasks, and
// local models decode slowly — full-depth thinking blows the timeout (ignored by cloud APIs)
// Reasoning off (DeepSeek): the same TOC came back in 10s instead of 284s
const CHAT_OPTS = { temperature: 0.3, responseFormat: "json_object" as const, timeoutMs: 600_000, reasoningEffort: "low" as const, thinking: false as const };

async function selectFromToc(
  toc: TocResult,
  catalog: HeadingCatalogEntry[],
  log: LogFn,
  where: string,
  chatOpts: LlmChatOptions,
  translateTo: string | undefined,
  size: { totalPages: number; totalWords: number }
): Promise<{ selections: HeadingSelection[]; chapterEntries: number; offsets: string | null } | null> {
  const tierPrompt = buildTierPrompt(toc, { translateTo, ...size });
  const chosen = parseTierResponse(await llmChat(tierPrompt.system, tierPrompt.user, chatOpts), toc);
  if (chosen.length === 0) {
    await log(`[AI] Could not tell chapters from sections in the table of contents${where}, selecting from headings instead`);
    return null;
  }
  await log(`[AI] ${chosen.length} of ${toc.entries.length} table-of-contents entries are chapters${where}`);

  const pageMap = buildPageMap(findAnchors(toc.entries, catalog));
  await log(
    pageMap
      ? `[AI] Printed page → PDF page offset${where}: ${pageMap.summary} (${pageMap.anchors.length} anchors)`
      : `[AI] Could not map printed page numbers to PDF pages${where}, matching by title alone`
  );

  const printed = (i: number) => toc.entries[i] ?? { title: "", page: null, level: null };
  const entries: ChapterEntry[] = chosen.map((c) => ({ index: c.i, titles: [printed(c.i).title, c.title], page: printed(c.i).page }));
  const { located, unresolved } = locateEntries(entries, catalog, pageMap);
  await log(
    `[AI] Placed ${located.length} of ${chosen.length} chapter headings ${pageMap ? "on their expected pages" : "by title"}${where}` +
      (unresolved.length > 0 ? `, asking the model about ${unresolved.length}` : "")
  );

  const placed = new Map(located.map((l) => [l.entry, l.blockIndex]));
  const askable = unresolved.filter((u) => u.candidates.length > 0);
  if (askable.length > 0) {
    const cleaned = new Map(chosen.map((c) => [c.i, c.title]));
    const prompt = buildResolvePrompt(
      askable.map((entry) => ({ entry, title: cleaned.get(entry.entry) ?? printed(entry.entry).title, printedPage: printed(entry.entry).page }))
    );
    const matches = parseResolveResponse(await llmChat(prompt.system, prompt.user, chatOpts), askable);
    for (const [entry, blockIndex] of matches) placed.set(entry, blockIndex);
    await log(`[AI] The model placed ${matches.size} of ${askable.length}${where}`);
  }
  const skipped = chosen.filter((c) => !placed.has(c.i));
  if (skipped.length > 0) {
    await log(`[AI] No heading found for ${skipped.length} chapter${skipped.length === 1 ? "" : "s"}${where}: ${skipped.slice(0, 5).map((c) => `"${c.title}"`).join(", ")}${skipped.length > 5 ? ", ..." : ""}`);
  }

  const byBlock = new Map<number, HeadingSelection>();
  for (const c of chosen) {
    const blockIndex = placed.get(c.i);
    if (blockIndex === undefined || byBlock.has(blockIndex)) continue;
    byBlock.set(blockIndex, { blockIndex, title: c.title, titleTranslated: c.translated });
  }
  return {
    selections: [...byBlock.values()].sort((a, b) => a.blockIndex - b.blockIndex),
    chapterEntries: chosen.length,
    offsets: pageMap?.summary ?? null,
  };
}

export function mergeHeadingOnlyStarts(blocks: FlatBlock[], selections: HeadingSelection[]): HeadingSelection[] {
  const merged: HeadingSelection[] = [];
  for (const selection of [...selections].sort((a, b) => a.blockIndex - b.blockIndex)) {
    const previous = merged.at(-1);
    const between = previous ? blocks.slice(previous.blockIndex, selection.blockIndex) : [];
    if (previous && between.length > 0 && between.every((b) => !b.included || !b.text.trim() || b.type === "SectionHeader")) {
      merged[merged.length - 1] = { ...selection, blockIndex: previous.blockIndex };
    } else {
      merged.push(selection);
    }
  }
  return merged;
}

type SourcePage = { fileIndex: number | null; page: number; pdfPath?: string };

type CombinedBook = {
  blocks: FlatBlock[];
  origins: { fileIndex: number | null; blockIndex: number }[];
  pages: Map<number, SourcePage>;
};

async function combineBook(files: SourceBlocks[]): Promise<CombinedBook> {
  const blocks: FlatBlock[] = [];
  const origins: CombinedBook["origins"] = [];
  const pages: CombinedBook["pages"] = new Map();
  let offset = 0;
  for (const file of files) {
    let pageCount = Math.max(0, ...file.blocks.map((b) => b.page));
    if (file.pdfPath) {
      try {
        const { stdout } = await execFileAsync("pdfinfo", [file.pdfPath], { timeout: 15_000 });
        const count = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
        if (Number.isInteger(count) && count > 0) pageCount = Math.max(pageCount, count);
      } catch {
        // Extracted page positions remain usable when the source PDF is unavailable.
      }
    }
    for (let page = 1; page <= pageCount; page++) {
      pages.set(offset + page, { fileIndex: file.fileIndex, page, pdfPath: file.pdfPath });
    }
    for (const [blockIndex, block] of file.blocks.entries()) {
      blocks.push({ ...block, page: offset + block.page });
      origins.push({ fileIndex: file.fileIndex, blockIndex });
    }
    offset += pageCount;
  }
  return { blocks, origins, pages };
}

async function findBookToc(book: CombinedBook, log: LogFn, chatOpts: LlmChatOptions): Promise<TocResult | null> {
  const totalPages = book.pages.size;
  const pageText = new Map<number, string[]>();
  for (const block of book.blocks) {
    const texts = pageText.get(block.page) ?? [];
    texts.push(block.text);
    pageText.set(block.page, texts);
  }
  const loaded = new Map<number, string>();
  const readWindow = async (pages: number[]) => {
    for (const page of pages) {
      if (loaded.has(page)) continue;
      const text = (pageText.get(page) ?? []).join("\n");
      const source = book.pages.get(page);
      const layer = source?.pdfPath ? await readPdfPageText(source.pdfPath, source.page) : null;
      const dense = (s: string) => s.replace(/\s+/g, "").length;
      loaded.set(page, ((layer && dense(layer) > dense(text)) ? layer : text).slice(0, MAX_PAGE_CHARS));
    }
    const pageBudget = Math.min(MAX_PAGE_CHARS, Math.floor(MAX_WINDOW_CHARS / Math.max(1, pages.length)) - 20);
    return mergePageTexts(pages.map((page) => ({ page, text: (loaded.get(page) ?? "").slice(0, pageBudget) })), new Map());
  };
  const frontPages = Array.from({ length: Math.min(WINDOW_PAGES, totalPages) }, (_, i) => i + 1);
  const search = async (pages: number[], side: "front" | "back") => {
    const text = await readWindow(pages);
    await log(`[AI] Looking for the book's contents in ${side} pages ${pages[0]}–${pages.at(-1)} (${text.length.toLocaleString()} characters)`);
    const prompt = buildTocPrompt(side === "front" ? text : "", side === "back" ? text : "");
    const toc = parseTocResponse(await llmChat(prompt.system, prompt.user, chatOpts));
    if (!toc) throw new Error("Table-of-contents response was not valid JSON");
    return { ...toc, tocPages: toc.tocPages.filter((page) => pages.includes(page)) };
  };
  let found: TocResult | null = null;
  try {
    let front = await search(frontPages, "front");
    if (front.found && front.entries.length >= MIN_TOC_ENTRIES) {
      let end = frontPages.at(-1) ?? 0;
      const start = Math.min(...front.tocPages, end);
      const maximum = Math.min(totalPages, end + WINDOW_PAGES);
      while (front.tocPages.includes(end) && end < totalPages) {
        if (end >= maximum) throw new Error("Front contents continues beyond the search allowance; refusing a partial contents list");
        end = Math.min(end + 3, maximum);
        front = await search(Array.from({ length: end - start + 1 }, (_, i) => start + i), "front");
        if (!front.found || front.entries.length < MIN_TOC_ENTRIES) throw new Error("Could not confirm the complete front contents list");
      }
      return front;
    }
    const remaining = Math.min(WINDOW_PAGES, totalPages - frontPages.length);
    for (let count = Math.min(3, remaining); count > 0; count = Math.min(count + 3, remaining)) {
      const pages = Array.from({ length: count }, (_, i) => totalPages - count + i + 1);
      const back = await search(pages, "back");
      if (back.found && back.entries.length >= MIN_TOC_ENTRIES) {
        found = back;
        // A contents page at the window edge may continue onto the preceding page.
        if (!back.tocPages.includes(pages[0] ?? 0)) return back;
      }
      if (count === remaining) break;
    }
  } catch (err) {
    await log(`[AI] Contents search stopped: ${describeError(err)}`);
  }
  return found;
}

export async function detectChaptersWithLlm(
  files: SourceBlocks[],
  log: LogFn,
  opts: { translateTo?: string; model?: string } = {}
): Promise<LlmDetection | null> {
  const chatOpts: LlmChatOptions = { ...CHAT_OPTS, model: opts.model };
  const book = await combineBook(files);
  if (book.blocks.length === 0) return null;
  await log(`[AI] Treating ${files.length} source file(s) as one book (${book.pages.size} pages)`);
  const toc = await findBookToc(book, log, chatOpts);
  await log(toc
    ? `[AI] Found the book's contents on page(s) ${toc.tocPages.join(", ")}: ${toc.entries.length} entries`
    : "[AI] No usable table of contents found; selecting from the book's combined headings");
  const catalog = buildHeadingCatalog(book.blocks, new Set(toc?.tocPages ?? []));
  if (catalog.length === 0) return null;
  const guided = toc ? await selectFromToc(toc, catalog, log, " in the book", chatOpts, opts.translateTo, { totalPages: book.pages.size, totalWords: cumulativeWords(book.blocks).total }) : null;
  let selections = guided?.selections ?? null;
  if (!selections || selections.length < 2) {
    await log(`[AI] Choosing chapter starts among ${catalog.length} headings across the whole book`);
    const prompt = buildSelectionPrompt(toc, catalog, { translateTo: opts.translateTo });
    selections = parseSelectionResponse(await llmChat(prompt.system, prompt.user, chatOpts), catalog);
  }
  if (!selections || selections.length < 2) return null;

  const merged = mergeHeadingOnlyStarts(book.blocks, selections);
  if (merged.length !== selections.length) await log(`[AI] Folded ${selections.length - merged.length} title-only grouping labels into their following chapters`);
  selections = merged;
  const selected = new Map<number | null, HeadingSelection[]>();
  for (const selection of selections) {
    const origin = book.origins[selection.blockIndex];
    if (!origin) continue;
    const local = selected.get(origin.fileIndex) ?? [];
    local.push({ ...selection, blockIndex: origin.blockIndex });
    selected.set(origin.fileIndex, local);
  }
  const tocs: ChapterProposalToc[] = [];
  if (toc) {
    const sourcePages = new Map<number | null, number[]>();
    for (const page of toc.tocPages) {
      const source = book.pages.get(page);
      if (!source) continue;
      const pages = sourcePages.get(source.fileIndex) ?? [];
      pages.push(source.page);
      sourcePages.set(source.fileIndex, pages);
    }
    for (const [fileIndex, pages] of sourcePages) {
      tocs.push({ fileIndex, pages, entries: toc.entries, chapterEntries: selections.length, offsets: guided?.offsets ?? null });
    }
  }
  await log(`[AI] Selected ${selections.length} chapter starts from ${catalog.length} headings across the whole book`);
  return { selected, toc: tocs };
}
