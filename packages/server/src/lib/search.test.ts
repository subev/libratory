import { describe, expect, it } from "vitest";
import { groupHits, type SearchHit } from "./search.ts";

let counter = 0;
function hit(overrides: Partial<SearchHit>): SearchHit {
  return {
    chunkId: `chunk-${counter++}`,
    bookId: "book-1",
    bookTitle: "Book",
    source: "raw",
    bookFileId: "file-1",
    chapterId: null,
    chapterTitle: null,
    chapterIndex: null,
    chapterFileId: null,
    translationId: null,
    language: null,
    seq: 0,
    charStart: 0,
    charEnd: 100,
    pageStart: null,
    pageEnd: null,
    text: "some english text about wealth and fortune",
    score: 0.03,
    ...overrides,
  };
}

describe("groupHits", () => {
  it("keeps the highest-scored hit per unit and collapses same-passage twins", () => {
    const top = hit({ chapterId: "ch-1", source: "chapter", score: 0.05, charStart: 0, charEnd: 100 });
    const twin = hit({ chapterId: "ch-1", source: "translation", language: "bg", score: 0.04, charStart: 10, charEnd: 90, text: "текст за богатство" });
    const result = groupHits([top, twin], "wealth", 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.chunkId).toBe(top.chunkId);
  });

  it("keeps a second non-overlapping passage from the same unit", () => {
    const a = hit({ chapterId: "ch-1", source: "chapter", score: 0.05, charStart: 0, charEnd: 100 });
    const b = hit({ chapterId: "ch-1", source: "chapter", score: 0.04, charStart: 500, charEnd: 600 });
    const result = groupHits([a, b], "wealth", 10);
    expect(result).toHaveLength(2);
  });

  it("prefers the translation matching a Cyrillic query when scores are close", () => {
    const english = hit({ chapterId: "ch-1", source: "chapter", score: 0.05, charStart: 0, charEnd: 100 });
    const bulgarian = hit({
      chapterId: "ch-1",
      source: "translation",
      language: "bg",
      score: 0.045,
      charStart: 200,
      charEnd: 300,
      text: "той натрупа голямо богатство от търговия",
    });
    const result = groupHits([english, bulgarian], "как забогатя той", 10);
    expect(result[0]?.source).toBe("translation");
  });

  it("drops raw hits whose pages duplicate an extracted chapter hit, keeping its own citation pages", () => {
    const chapterHit = hit({ chapterId: "ch-1", source: "chapter", bookFileId: null, chapterFileId: "file-1", score: 0.05, pageStart: 10, pageEnd: 14 });
    const rawTwin = hit({ bookFileId: "file-1", source: "raw", score: 0.04, pageStart: 12, pageEnd: 13, charStart: 900, charEnd: 1000 });
    const result = groupHits([chapterHit, rawTwin], "wealth", 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("chapter");
    expect(result[0]?.pageStart).toBe(10);
    expect(result[0]?.pageEnd).toBe(14);
  });

  it("swaps a raw hit for its lower-scored chapter twin, keeping its own citation pages", () => {
    const rawHit = hit({ bookFileId: "file-1", source: "raw", score: 0.05, pageStart: 12, pageEnd: 13, charStart: 900, charEnd: 1000 });
    const chapterTwin = hit({ chapterId: "ch-1", source: "chapter", bookFileId: null, chapterFileId: "file-1", score: 0.04, pageStart: 10, pageEnd: 14 });
    const result = groupHits([rawHit, chapterTwin], "wealth", 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("chapter");
    expect(result[0]?.chunkId).toBe(chapterTwin.chunkId);
    expect(result[0]?.pageStart).toBe(10);
    expect(result[0]?.pageEnd).toBe(14);
  });

  it("caps hits per book", () => {
    const hits = Array.from({ length: 6 }, (_, i) =>
      hit({ bookFileId: `file-${i}`, score: 0.05 - i * 0.001, charStart: i * 1000, charEnd: i * 1000 + 100 }),
    );
    const result = groupHits(hits, "wealth", 10);
    expect(result).toHaveLength(3);
  });

  it("respects the overall limit", () => {
    const hits = Array.from({ length: 10 }, (_, i) =>
      hit({ bookId: `book-${i}`, bookFileId: `file-${i}`, score: 0.05 - i * 0.001 }),
    );
    expect(groupHits(hits, "wealth", 4)).toHaveLength(4);
  });
});

it("keeps different PDFs and different passages on the same page distinct", () => {
  const chapter = hit({ source:"chapter", chapterId:"ch", bookFileId:null, chapterFileId:"file-A", pageStart:10, pageEnd:10, score:0.05 });
  const otherFile = hit({ bookFileId:"file-B", pageStart:10, pageEnd:10, score:0.04 });
  expect(groupHits([chapter,otherFile],"wealth",10)).toHaveLength(2);
  const otherPassage = hit({ bookFileId:"file-A", pageStart:10, pageEnd:10, text:"An entirely separate account about a different topic", score:0.04 });
  expect(groupHits([chapter,otherPassage],"wealth",10)).toHaveLength(2);
});
it("honours the requested book-scoped limit while retaining library diversification", () => {
  const hits = Array.from({length:8},(_,i)=>hit({source:"chapter",chapterId:`ch-${i}`,score:0.1-i*0.001}));
  expect(groupHits(hits,"wealth",8,{bookId:"book-1"})).toHaveLength(8);
  expect(groupHits(hits,"wealth",8)).toHaveLength(3);
});
