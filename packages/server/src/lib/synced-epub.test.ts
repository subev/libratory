import { describe, expect, it } from "vitest";
import type { ReaderCues, ReaderManifest } from "./reader-format.ts";
import { chapterTextFromCues, documentFormatOf, isReaderCues, isReaderManifest, layerEntryPath, syncMapFromCues } from "./synced-epub.ts";

const cues: ReaderCues = {
  format: "p2af/1",
  totalMs: 9000,
  granularity: "sentence",
  cues: [
    { t: [0, 2000], s: "One two.", c: 0, w: [[0, 900, "One"], [900, 2000, "two."]] },
    { t: [2000, 4000], s: "Three four.", c: 0, w: [[2000, 3000, "Three"], [3000, 4000, "four."]] },
    { t: [4500, 9000], s: "Five six seven.", c: 1 },
  ],
};

describe("syncMapFromCues", () => {
  it("groups cues back into chunks and keeps word timings only where every cue had them", () => {
    expect(syncMapFromCues(cues)).toEqual({
      version: 2,
      totalMs: 9000,
      chunks: [
        {
          text: "One two. Three four.",
          startMs: 0,
          endMs: 4000,
          words: [
            { text: "One", after: " ", startMs: 0, endMs: 900 },
            { text: "two.", after: " ", startMs: 900, endMs: 2000 },
            { text: "Three", after: " ", startMs: 2000, endMs: 3000 },
            { text: "four.", after: "", startMs: 3000, endMs: 4000 },
          ],
        },
        { text: "Five six seven.", startMs: 4500, endMs: 9000 },
      ],
    });
  });
});

describe("chapterTextFromCues", () => {
  it("is the cues in order, a chunk per line, unless the document carries its text", () => {
    expect(chapterTextFromCues(cues)).toBe("One two. Three four.\nFive six seven.");
    expect(chapterTextFromCues({ ...cues, text: { format: "p2af/1", text: "As written." } })).toBe("As written.");
  });
});

describe("layerEntryPath", () => {
  it("resolves a resource against book.json inside the zip", () => {
    expect(layerEntryPath("OEBPS/p2af/book.json", "cues/ch000.json")).toBe("OEBPS/p2af/cues/ch000.json");
    expect(layerEntryPath("OEBPS/p2af/book.json", "../audio/ch000.m4a")).toBe("OEBPS/audio/ch000.m4a");
    expect(layerEntryPath("p2af/book.json", "../audio/ch000.m4a")).toBe("audio/ch000.m4a");
  });
});

const manifest = (chapters: ReaderManifest["chapters"]): ReaderManifest => ({
  format: "p2af/1",
  book: { id: "b", title: "T", author: null, language: "de", medianBodyPt: null, cover: null },
  sources: [],
  pages: [],
  chapters,
});

describe("documentFormatOf", () => {
  it("is bilingual when a chapter names a translation, else read-along", () => {
    const chapter = { i: 0, id: "c", title: "I", audio: null, cues: null, text: null, durationMs: null, pageStart: null, pageEnd: null, mode: "text" as const };
    expect(documentFormatOf(manifest([chapter]))).toEqual({ format: "epub-sync", language: null });
    expect(documentFormatOf(manifest([{ ...chapter, bilingual: [{ key: "English", language: "en", url: "bilingual/x.json" }] }]))).toEqual({ format: "epub-bilingual", language: "English" });
  });
});

describe("isReaderCues", () => {
  it("accepts what the import reads and refuses the rest", () => {
    expect(isReaderCues(cues)).toBe(true);
    expect(isReaderCues({ totalMs: 1, cues: [] })).toBe(true);
    expect(isReaderCues({ totalMs: "1", cues: [] })).toBe(false);
    expect(isReaderCues({ totalMs: 1, cues: [{ t: [0], s: "x", c: 0 }] })).toBe(false);
    expect(isReaderCues({ totalMs: 1, cues: [{ t: [0, 1], s: "x", c: 0, w: [[0, 1]] }] })).toBe(false);
    expect(isReaderCues("nope")).toBe(false);
  });
});

describe("isReaderManifest", () => {
  it("accepts the layer's shape and nothing else", () => {
    expect(isReaderManifest(manifest([]))).toBe(true);
    expect(isReaderManifest({ format: "epub", book: {}, chapters: [] })).toBe(false);
    expect(isReaderManifest(null)).toBe(false);
  });
});
