// The wire format of the two documents the reader consumes, and nothing else — no imports, so
// the web package can take these types straight across the boundary rather than re-declaring them.
export const READER_FORMAT = "p2af/1";

export type Rect = [x: number, y: number, width: number, height: number];

// [page, x, y, width, height]: flat page index, then ten-thousandths of the page box, origin top-left
export type CueRect = [number, number, number, number, number];

export type CueGranularity = "word" | "sentence" | "chunk";

// `p` is the page's number inside its own PDF, which is what a PDF renderer is asked for
export type ReaderPage = { i: number; src: number; p: number; w: number; h: number; rot: number; content: Rect; columns: Rect[] };

export type ReaderSource = { index: number; filename: string; url: string; pageCount: number };

// `why` says what took the marking away, so a reader can explain itself rather than guess
export type ReaderUnmapped = "edited" | "generated" | "unmapped" | "unnarrated";

export type ReaderChapter = {
  i: number;
  id: string;
  title: string;
  audio: string | null;
  // null when the chapter has no narration: a container cannot carry a path to a missing file
  cues: string | null;
  // The chapter's own text, for reading a chapter no narration has been made for yet
  text: string | null;
  durationMs: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  mode: "page" | "text";
  why?: ReaderUnmapped;
};

export type ReaderManifest = {
  format: string;
  // `cover` is a URL like the rest, resolved against this document; null when nothing carries one
  book: { id: string; title: string; author: string | null; language: string; medianBodyPt: number | null; cover: string | null };
  sources: ReaderSource[];
  pages: ReaderPage[];
  chapters: ReaderChapter[];
};

// `wr` is aligned with `w`: the rects for each word, so the page can mark the word being spoken
export type ReaderCue = {
  t: [number, number];
  s: string;
  c: number;
  r?: CueRect[];
  w?: [number, number, string][];
  wr?: CueRect[][];
};

export type ReaderCues = { format: string; totalMs: number; granularity: CueGranularity; cues: ReaderCue[] };

export type ReaderText = { format: string; text: string };
