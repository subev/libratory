import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { and, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../db.ts";
import { books } from "../schema.ts";
import { searchLibrary, expandPassage, type SearchHit } from "./search.ts";
import { folderSubtreeIds } from "./folders.ts";

export type CitationSource = {
  id: string;
  chunkId: string;
  kind: "raw" | "chapter" | "translation";
  bookId: string;
  bookTitle: string;
  fileId: string | null;
  page: number | null;
  chapterId: string | null;
  chapterTitle: string | null;
  language: string | null;
  // Absent on sources a transcript kept from before these existed
  chapterIndex?: number | null;
  // How the passage starts, so six citations of one chapter can be told apart
  snippet?: string;
  // Where the narration speaks it, in ms — set only once the answer cites it (citation-targets.ts)
  readAt?: number | null;
};

const SNIPPET_CHARS = 140;

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  const cut = flat.slice(0, SNIPPET_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), SNIPPET_CHARS / 2))}…`;
}

// Stable, verifiable citation ids for one request: tools register every passage
// they return, the model may only cite registered ids (toc-detect discipline)
export class CitationCatalog {
  private byId = new Map<string, CitationSource>();
  private byChunk = new Map<string, string>();
  private next = 1;

  seed(sources: CitationSource[]) {
    for (const source of sources) {
      if (this.byId.has(source.id)) continue;
      this.byId.set(source.id, source);
      this.byChunk.set(source.chunkId, source.id);
      const n = Number(source.id.replace("c_", ""));
      if (Number.isFinite(n) && n >= this.next) this.next = n + 1;
    }
  }

  register(hit: SearchHit): CitationSource {
    const existingId = this.byChunk.get(hit.chunkId);
    if (existingId) return this.byId.get(existingId)!;
    const id = `c_${this.next++}`;
    const source: CitationSource = {
      id,
      chunkId: hit.chunkId,
      kind: hit.source,
      bookId: hit.bookId,
      bookTitle: hit.bookTitle,
      fileId: hit.bookFileId ?? hit.chapterFileId,
      page: hit.pageStart,
      chapterId: hit.chapterId,
      chapterTitle: hit.chapterTitle,
      language: hit.language,
      chapterIndex: hit.chapterIndex,
      snippet: snippetOf(hit.text),
    };
    this.byId.set(id, source);
    this.byChunk.set(hit.chunkId, id);
    return source;
  }

  get(id: string): CitationSource | undefined {
    return this.byId.get(id);
  }
}

function describeHit(source: CitationSource, hit: SearchHit): string {
  const parts = [`"${hit.bookTitle}"`];
  if (hit.chapterTitle) parts.push(`chapter "${hit.chapterTitle}"`);
  if (hit.source === "translation" && hit.language) parts.push(`${hit.language} translation`);
  if (hit.pageStart != null) parts.push(hit.pageEnd != null && hit.pageEnd !== hit.pageStart ? `pp. ${hit.pageStart}–${hit.pageEnd}` : `p. ${hit.pageStart}`);
  return `[${source.id}] ${parts.join(", ")}:\n${hit.text}`;
}

// What one chat may search. `bookIds` is the chosen set and is enforced by every tool — an empty
// one matches nothing, it never widens to the library.
export type ChatSearchScope = { profileId: string; folderId?: string; bookIds?: string[] };

async function scopeBookFilters(scope: ChatSearchScope): Promise<SQL[]> {
  const filters: SQL[] = [eq(books.profileId, scope.profileId)];
  if (scope.bookIds) filters.push(scope.bookIds.length > 0 ? inArray(books.id, scope.bookIds) : sql`false`);
  else if (scope.folderId) filters.push(inArray(books.folderId, await folderSubtreeIds(scope.folderId)));
  return filters;
}

export function buildChatTools(opts: ChatSearchScope & { catalog: CitationCatalog }): ToolSet {
  const { profileId, folderId, bookIds, catalog } = opts;
  // One chosen book keeps the single-book ranking, which lifts the per-book cap on passages
  const bookId = bookIds?.length === 1 ? bookIds[0] : undefined;

  return {
    search_library: tool({
      description:
        "Search the user's book library. Hybrid keyword + semantic search across original book text and translations, in any language. Returns passages labeled with citation ids like [c_3]. Call this before answering; refine the query when results are weak.",
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe("The search query — keywords or a natural-language question"),
        limit: z.number().int().min(1).max(20).optional().describe("Max passages to return (default 8)"),
      }),
      execute: async ({ query, limit }) => {
        const result = await searchLibrary({ profileId, folderId, bookId, bookIds, query, limit: limit ?? 8 });
        if (result.hits.length === 0) return "No matching passages found. Try different keywords.";
        const blocks = result.hits.map((hit) => describeHit(catalog.register(hit), hit));
        const note = result.mode === "keyword" ? "\n\n(Semantic search unavailable — keyword results only.)" : "";
        return blocks.join("\n\n---\n\n") + note;
      },
    }),

    read_passage: tool({
      description:
        "Read the wider context around a passage previously returned by search_library. Use when a snippet looks relevant but is cut off or you need surrounding detail.",
      inputSchema: z.object({
        id: z.string().regex(/^c_\d+$/).describe("A citation id from search_library, e.g. c_3"),
        before: z.number().int().min(0).max(3).optional().describe("Extra chunks of context before (default 1)"),
        after: z.number().int().min(0).max(3).optional().describe("Extra chunks of context after (default 1)"),
      }),
      execute: async ({ id, before, after }) => {
        const source = catalog.get(id);
        if (!source) return `Unknown citation id ${id} — only ids returned by search_library exist.`;
        const expanded = await expandPassage(source.chunkId, before ?? 1, after ?? 1);
        if (!expanded) return `Passage ${id} is no longer available (the book may have been re-indexed).`;
        return describeHit(source, { ...expanded.hit, text: expanded.text });
      },
    }),

    list_books: tool({
      description:
        "List books in the user's library (titles and sizes, no content). Use for meta questions like 'what books do I have about X' — for content questions use search_library.",
      inputSchema: z.object({
        query: z.string().max(200).optional().describe("Optional title filter"),
      }),
      execute: async ({ query }) => {
        const filters = await scopeBookFilters(opts);
        if (query?.trim()) {
          for (const word of query.trim().split(/\s+/).slice(0, 8)) {
            filters.push(ilike(books.title, `%${word.replace(/[\\%_]/g, "\\$&")}%`));
          }
        }
        const rows = await db
          .select({
            id: books.id,
            title: books.title,
            words: sql<number>`coalesce((SELECT sum(raw_words)::int FROM book_files bf WHERE bf.book_id = ${books.id} AND bf.raw_text IS NOT NULL), 0)`,
          })
          .from(books)
          .where(and(...filters))
          .orderBy(books.title)
          .limit(100);
        if (rows.length === 0) return "No books match.";
        return rows.map((r) => `- ${r.title}${r.words ? ` (~${r.words.toLocaleString()} words)` : ""}`).join("\n");
      },
    }),
  };
}

// The languages of the books in scope, most books first. Null and unknown languages are left out.
export async function scopeLanguages(opts: ChatSearchScope): Promise<string[]> {
  const filters = [...(await scopeBookFilters(opts)), sql`${books.language} IS NOT NULL`];
  const rows = await db
    .select({ language: books.language })
    .from(books)
    .where(and(...filters))
    .groupBy(books.language)
    .orderBy(sql`count(*) DESC`);
  return [...new Set(rows.flatMap((row) => (row.language ? [languageName(row.language)] : [])))];
}

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

// books.language is an ISO code; a model follows "Bulgarian" more reliably than "bg"
function languageName(code: string): string {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

// A query is matched against the book's own words, so it is written in the book's language —
// whatever the question was asked in. The model used to be told the library "mixes English and
// Bulgarian" and ran every search twice, once in a language the book does not contain.
export function searchLanguageRule(languages: string[]): string {
  const [only, ...others] = languages;
  if (only === undefined) return "Write search queries in the language of the user's question.";
  if (others.length === 0) {
    return `Every book in scope is in ${only}. Write every search query in ${only}, whatever language the question is asked in — do not repeat a search in another language.`;
  }
  return `The books in scope are in: ${languages.join(", ")}. Write search queries in English by default. Search in one of the other languages only when the question is plainly about a book in that language, or when the English searches found nothing — never run the same search in two languages as a matter of course.`;
}
