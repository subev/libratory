// The reader consumes these two documents and nothing else — never a database row. The types are
// the server's own, so a field added there cannot go unnoticed here.
export type {
  CueRect,
  ReaderChapter,
  ReaderCue,
  ReaderCues,
  ReaderManifest,
  ReaderPage,
  ReaderUnmapped,
  Rect,
} from "../../../server/src/lib/reader-format.ts";
import type {
  ReaderChapter,
  ReaderUnmapped,
  ReaderCue,
  ReaderCues,
  ReaderManifest,
  ReaderPage,
  Rect,
} from "../../../server/src/lib/reader-format.ts";

export async function fetchManifest(bookId: string): Promise<ReaderManifest> {
  return fetchJson(`/read/book/${bookId}/book.json`);
}

export async function fetchCues(url: string): Promise<ReaderCues> {
  return fetchJson(url);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

// Cues are ordered and non-overlapping, so the one playing is a binary search away
export function cueIndexAt(cues: ReaderCue[], ms: number): number {
  let low = 0;
  let high = cues.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const cue = cues[mid];
    if (!cue || cue.t[0] > ms) high = mid - 1;
    else {
      found = mid;
      low = mid + 1;
    }
  }
  // Before the first word (Kokoro's can start 275ms in) and in the gaps between cues, one stays lit
  return found >= 0 ? found : cues.length > 0 ? 0 : -1;
}

export function wordIndexAt(cue: ReaderCue, ms: number): number {
  if (!cue.w) return -1;
  for (let i = cue.w.length - 1; i >= 0; i--) {
    const word = cue.w[i];
    if (word && ms >= word[0]) return ms < word[1] ? i : -1;
  }
  return -1;
}

// Rects are ten-thousandths of the whole page; the crop, in points, is what is on screen
export function cropStyle(page: ReaderPage, crop: Rect, x: number, y: number, width: number, height: number) {
  const left = (x / 10_000) * page.w;
  const top = (y / 10_000) * page.h;
  return {
    left: `${((left - crop[0]) / crop[2]) * 100}%`,
    top: `${((top - crop[1]) / crop[3]) * 100}%`,
    width: `${(((width / 10_000) * page.w) / crop[2]) * 100}%`,
    height: `${(((height / 10_000) * page.h) / crop[3]) * 100}%`,
  };
}

export function wholePage(page: ReaderPage): Rect {
  return [0, 0, page.w, page.h];
}

// iOS body text is 17 logical points, which is the same number of CSS pixels here
export const COMFORTABLE_BODY_PX = 17;

export function bodyFit(medianBodyPt: number | null, cropWidthPt: number, renderedWidthPx: number) {
  // Nothing measured yet is not the same as "renders at 0px, unreadable" — say nothing instead
  if (medianBodyPt === null || cropWidthPt <= 0 || renderedWidthPx <= 0) return null;
  const px = medianBodyPt * (renderedWidthPx / cropWidthPt);
  return { px, percent: Math.round((px / COMFORTABLE_BODY_PX) * 100) };
}

// What took the page mapping away, in the reader's words. The document states which it was, so
// neither surface has to guess from a database row. The map is written while a chapter is
// narrated, which is what separates the last two: one has never been narrated, the other was
// narrated before the map existed, and narrating it again is the fix.
export const UNMAPPED: Record<ReaderUnmapped, string> = {
  edited: "This chapter's text was edited after extraction, so the narration can't be lined up with the print.",
  generated: "This chapter's text was written rather than extracted, so there is no print to line it up with.",
  unmapped: "This chapter was narrated before pages could be lined up — re-synthesize it to mark the words.",
  unnarrated: "This chapter hasn't been narrated yet.",
};

// The pages a chapter covers, in flat order — the same set both surfaces render. It reads the page
// range and nothing else, so callers can memoize on those two fields rather than on chapter identity.
export function chapterPages(manifest: ReaderManifest, chapter: Pick<ReaderChapter, "pageStart" | "pageEnd">): ReaderPage[] {
  if (chapter.pageStart === null) return [];
  const last = chapter.pageEnd ?? chapter.pageStart;
  return manifest.pages.filter((page) => page.i >= chapter.pageStart! && page.i <= last);
}

export function cuesOfChunk(cues: ReaderCue[], chunk: number | null): ReaderCue[] {
  return chunk === null ? [] : cues.filter((cue) => cue.c === chunk);
}

export function cueAtPoint(cues: ReaderCue[], page: number, x: number, y: number): number {
  return cues.findIndex((cue) =>
    cue.r?.some(([p, rx, ry, rw, rh]) => p === page && x >= rx && x <= rx + rw && y >= ry && y <= ry + rh),
  );
}
