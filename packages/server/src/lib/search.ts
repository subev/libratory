import { sql, and, eq, inArray, asc, gte, lte } from "drizzle-orm";
import { db } from "../db.ts";
import { books, bookChunks, chapters } from "../schema.ts";
import { embedQuery } from "./embeddings.ts";
import { folderSubtreeIds } from "./folders.ts";

export type SearchHit = {
  chunkId: string;
  bookId: string;
  bookTitle: string;
  source: "raw" | "chapter" | "translation";
  bookFileId: string | null;
  chapterId: string | null;
  chapterTitle: string | null;
  chapterIndex: number | null;
  // The chapter's source PDF file, when resolvable — lets chapter citations deep-link a page
  chapterFileId: string | null;
  translationId: string | null;
  language: string | null;
  seq: number;
  charStart: number;
  charEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  score: number;
};

export type SearchResult = {
  hits: SearchHit[];
  mode: "hybrid" | "keyword";
};

const LEG_LIMIT = 50;
const RRF_K = 60;
const PER_GROUP = 2;
const PER_BOOK = 3;

function cyrillicRatio(text: string): number {
  if (!text) return 0;
  let cyrillic = 0;
  let letters = 0;
  for (const ch of text) {
    if (/[a-zA-Z]/.test(ch)) letters++;
    else if (/[Ѐ-ӿ]/.test(ch)) {
      letters++;
      cyrillic++;
    }
  }
  return letters === 0 ? 0 : cyrillic / letters;
}

function pagesOverlap(a: SearchHit, b: SearchHit): boolean {
  if (a.pageStart == null || a.pageEnd == null || b.pageStart == null || b.pageEnd == null) return false;
  return a.pageStart <= b.pageEnd && b.pageStart <= a.pageEnd;
}

function charsOverlap(a: SearchHit, b: SearchHit): boolean {
  return a.charStart < b.charEnd && b.charStart < a.charEnd;
}

function sameSourcePassage(a: SearchHit, b: SearchHit): boolean {
  const fileA = a.source === "raw" ? a.bookFileId : a.chapterFileId;
  const fileB = b.source === "raw" ? b.bookFileId : b.chapterFileId;
  if (a.bookId !== b.bookId || !fileA || fileA !== fileB || !pagesOverlap(a, b)) return false;
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const left = words(a.text);
  const right = words(b.text);
  if (left.length > 0 && left.join(" ") === right.join(" ")) return true;
  const shingles = (tokens: string[]) => new Set(tokens.slice(7).map((_, i) => tokens.slice(i, i + 8).join(" ")));
  const first = shingles(left);
  const second = shingles(right);
  const common = [...first].filter((part) => second.has(part)).length;
  return common >= 3 && common >= Math.min(first.size, second.size) * 0.6;
}

// The same passage can hit as original + N translations (and as raw + chapter
// text of the same pages). Collapse near-duplicates, prefer the query's script
// on close scores, and cap per-book dominance.
export function groupHits(hits: SearchHit[], query: string, limit: number, scope: { bookId?: string } = {}): SearchHit[] {
  const queryCyrillic = cyrillicRatio(query) > 0.5;
  const sorted = [...hits].sort((a, b) => b.score - a.score);

  const byGroup = new Map<string, SearchHit[]>();
  for (const hit of sorted) {
    const key = hit.chapterId ?? hit.bookFileId ?? hit.bookId;
    const group = byGroup.get(key);
    if (!group) {
      byGroup.set(key, [hit]);
      continue;
    }
    if (group.length >= (hit.bookId === scope.bookId ? limit : PER_GROUP)) continue;
    // A second hit from the same unit must be a different passage, not the
    // translated/cleaned twin of the first
    if (group.some((g) => (g.source === hit.source && g.language === hit.language ? charsOverlap(g, hit) : true))) continue;
    group.push(hit);
  }

  // Within a group, swap the representative for its language twin when the
  // query's script matches and scores are close
  const representatives: SearchHit[] = [];
  for (const [key, group] of byGroup) {
    void key;
    const [top] = group;
    if (!top) continue;
    const twin = sorted.find(
      (h) =>
        h !== top &&
        (h.chapterId ?? h.bookFileId ?? h.bookId) === (top.chapterId ?? top.bookFileId ?? top.bookId) &&
        charsOverlap(h, top) === false &&
        h.score >= top.score * 0.8 &&
        (cyrillicRatio(h.text) > 0.5) === queryCyrillic,
    );
    const preferTwin = twin && (cyrillicRatio(top.text) > 0.5) !== queryCyrillic;
    representatives.push(...(preferTwin ? [twin, ...group.slice(1)] : group));
  }

  representatives.sort((a, b) => b.score - a.score);

  // Prefer the chapter only when text overlaps in the same source PDF; each hit
  // keeps its own citation range, since both raw and chapter chunks map pages.
  const out: SearchHit[] = [];
  const perBook = new Map<string, number>();
  for (const hit of representatives) {
    const count = perBook.get(hit.bookId) ?? 0;
    if (hit.source === "raw") {
      const twinIdx = out.findIndex((o) => o.source === "chapter" && sameSourcePassage(o, hit));
      const twin = out[twinIdx];
      if (twin) {
        continue;
      }
    } else if (hit.source === "chapter") {
      const rawTwinIdx = out.findIndex((o) => o.source === "raw" && sameSourcePassage(o, hit));
      const raw = out[rawTwinIdx];
      if (raw) {
        out[rawTwinIdx] = { ...hit, score: raw.score };
        continue;
      }
    }
    if (count >= (hit.bookId === scope.bookId ? limit : PER_BOOK) || out.length >= limit) continue;
    out.push(hit);
    perBook.set(hit.bookId, count + 1);
  }
  return out;
}

async function scopedBookIds(profileId: string, folderId?: string): Promise<string[] | null> {
  if (!folderId) return null;
  const folderIds = await folderSubtreeIds(folderId);
  if (folderIds.length === 0) return [];
  const rows = await db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.profileId, profileId), inArray(books.folderId, folderIds)));
  return rows.map((r) => r.id);
}

export async function searchLibrary(opts: {
  profileId: string;
  folderId?: string;
  bookId?: string;
  // A chosen set of books; an empty one finds nothing rather than widening to the library
  bookIds?: string[];
  query: string;
  limit?: number;
  mode?: "hybrid" | "keyword";
}): Promise<SearchResult> {
  const { profileId, folderId, query } = opts;
  const limit = opts.limit ?? 12;
  const bookIds = opts.bookId ? [opts.bookId] : (opts.bookIds ?? await scopedBookIds(profileId, folderId));
  if (bookIds !== null && bookIds.length === 0) return { hits: [], mode: "keyword" };

  const vector = opts.mode === "keyword" ? null : await embedQuery(query);
  const mode: SearchResult["mode"] = vector ? "hybrid" : "keyword";

  // Single text param → set of uuids; drizzle expands a JS array param into a
  // record `(a,b,c)`, which cannot cast to uuid[]
  const bookFilter = bookIds !== null
    ? sql` AND c.book_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(bookIds)}::jsonb)::uuid)`
    : sql``;
  const vectorParam = vector ? JSON.stringify(vector) : null;

  const vecLeg = vector
    ? sql`
      SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> ${vectorParam}::vector) AS r
      FROM book_chunks c
      WHERE c.profile_id = ${profileId} AND c.embedding IS NOT NULL${bookFilter}
      ORDER BY c.embedding <=> ${vectorParam}::vector
      LIMIT ${LEG_LIMIT}`
    : sql`SELECT NULL::uuid AS id, NULL::bigint AS r WHERE false`;

  const rows = (await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
    return tx.execute(sql`
      WITH fts AS (
        SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS r
        FROM book_chunks c, websearch_to_tsquery('simple', ${query}) q
        WHERE c.profile_id = ${profileId} AND c.tsv @@ q${bookFilter}
        ORDER BY ts_rank_cd(c.tsv, q) DESC
        LIMIT ${LEG_LIMIT}
      ),
      vec AS (${vecLeg}),
      fused AS (
        SELECT COALESCE(fts.id, vec.id) AS id,
               COALESCE(1.0 / (${RRF_K} + fts.r), 0) + COALESCE(1.0 / (${RRF_K} + vec.r), 0) AS score
        FROM fts FULL OUTER JOIN vec ON fts.id = vec.id
      )
      SELECT
        c.id AS chunk_id, c.book_id, b.title AS book_title, c.source,
        c.book_file_id, c.chapter_id, ch.title AS chapter_title, ch.index AS chapter_index,
        bf.id AS chapter_file_id,
        c.translation_id, c.language, c.seq, c.char_start, c.char_end,
        c.page_start, c.page_end, c.text, fused.score
      FROM fused
      JOIN book_chunks c ON c.id = fused.id
      JOIN books b ON b.id = c.book_id
      LEFT JOIN chapters ch ON ch.id = c.chapter_id
      LEFT JOIN book_files bf ON bf.book_id = c.book_id AND bf.index = ch.source_file_index
      ORDER BY fused.score DESC
    `);
  })) as unknown as Array<Record<string, unknown>>;

  const hits: SearchHit[] = rows.map((r) => ({
    chunkId: r.chunk_id as string,
    bookId: r.book_id as string,
    bookTitle: r.book_title as string,
    source: r.source as SearchHit["source"],
    bookFileId: (r.book_file_id as string) ?? null,
    chapterId: (r.chapter_id as string) ?? null,
    chapterTitle: (r.chapter_title as string) ?? null,
    chapterIndex: (r.chapter_index as number) ?? null,
    chapterFileId: (r.chapter_file_id as string) ?? null,
    translationId: (r.translation_id as string) ?? null,
    language: (r.language as string) ?? null,
    seq: r.seq as number,
    charStart: r.char_start as number,
    charEnd: r.char_end as number,
    pageStart: (r.page_start as number) ?? null,
    pageEnd: (r.page_end as number) ?? null,
    text: r.text as string,
    score: Number(r.score),
  }));

  return { hits: groupHits(hits, query, limit, { bookId: opts.bookId }), mode };
}

// Adjacent chunks of the same source unit, merged into one continuous passage
// using true char offsets to drop the overlap regions
export async function expandPassage(chunkId: string, before = 1, after = 1): Promise<{ hit: SearchHit; text: string } | null> {
  const [chunk] = await db.select().from(bookChunks).where(eq(bookChunks.id, chunkId));
  if (!chunk) return null;

  const unitFilter = chunk.translationId
    ? eq(bookChunks.translationId, chunk.translationId)
    : chunk.chapterId
      ? and(eq(bookChunks.chapterId, chunk.chapterId), eq(bookChunks.source, chunk.source))
      : chunk.bookFileId
        ? eq(bookChunks.bookFileId, chunk.bookFileId)
        : eq(bookChunks.bookId, chunk.bookId);

  const neighbors = await db
    .select()
    .from(bookChunks)
    .where(and(unitFilter, gte(bookChunks.seq, chunk.seq - before), lte(bookChunks.seq, chunk.seq + after)))
    .orderBy(asc(bookChunks.seq));

  let text = "";
  let coveredTo = -1;
  for (const n of neighbors) {
    if (coveredTo === -1) {
      text = n.text;
    } else if (n.charStart < coveredTo) {
      text += n.text.slice(coveredTo - n.charStart);
    } else {
      text += "\n\n" + n.text;
    }
    coveredTo = Math.max(coveredTo, n.charEnd);
  }

  const [book] = await db.select({ title: books.title }).from(books).where(eq(books.id, chunk.bookId));
  const chapterRow = chunk.chapterId
    ? (await db.select({ title: chapters.title, index: chapters.index }).from(chapters).where(eq(chapters.id, chunk.chapterId)))[0]
    : null;

  const first = neighbors[0] ?? chunk;
  const last = neighbors[neighbors.length - 1] ?? chunk;
  return {
    hit: {
      chunkId: chunk.id,
      bookId: chunk.bookId,
      bookTitle: book?.title ?? "",
      source: chunk.source,
      bookFileId: chunk.bookFileId,
      chapterId: chunk.chapterId,
      chapterTitle: chapterRow?.title ?? null,
      chapterIndex: chapterRow?.index ?? null,
      chapterFileId: null,
      translationId: chunk.translationId,
      language: chunk.language,
      seq: chunk.seq,
      charStart: first.charStart,
      charEnd: last.charEnd,
      pageStart: first.pageStart ?? chunk.pageStart,
      pageEnd: last.pageEnd ?? chunk.pageEnd,
      text,
      score: 0,
    },
    text,
  };
}
