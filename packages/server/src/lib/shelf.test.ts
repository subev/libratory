import { describe, expect, it } from "vitest";
import { editionLabel, groupByBook, hashDeviceKey, newDeviceKey, type ShelfDocument } from "./shelf.ts";

describe("editionLabel", () => {
  it("names a bilingual EPUB by both languages", () => {
    expect(editionLabel("epub-bilingual", "de", "English")).toBe("German and English");
  });

  it("names a read-along by the language it is spoken in", () => {
    expect(editionLabel("epub-sync", "de", null)).toBe("German, read-along");
    expect(editionLabel("epub-sync", "de", "English")).toBe("English, read-along");
  });

  it("survives a book with no language", () => {
    expect(editionLabel("epub-sync", null, null)).toBe("Read-along");
    expect(editionLabel("epub-bilingual", null, "English")).toBe("English");
    expect(editionLabel("epub-sync", "not-a-code!!", null)).toBe("Read-along");
  });
});

describe("device keys", () => {
  it("are long, url-safe and hashed the same way twice", () => {
    const key = newDeviceKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(hashDeviceKey(key)).toBe(hashDeviceKey(key));
    expect(hashDeviceKey(key)).not.toBe(hashDeviceKey(newDeviceKey()));
  });
});

describe("groupByBook", () => {
  const doc = (over: Partial<ShelfDocument>): ShelfDocument => ({
    id: "d1",
    bookId: "b1",
    title: "Der Prozess",
    author: "Kafka",
    bookLanguage: "de",
    format: "epub-sync",
    language: null,
    label: "German, read-along",
    chapterCount: 10,
    chapterSummary: "",
    bytes: 1,
    createdAt: new Date("2026-10-01"),
    hidden: false,
    narration: null,
    downloadedBy: [],
    fetches: 0,
    ...over,
  });

  it("puts every file of one book under it and marks what this phone has", () => {
    const books = groupByBook(
      [
        doc({ id: "d1", downloadedBy: [{ deviceId: "phone", name: "Petur's iPhone" }] }),
        doc({ id: "d2", format: "epub-bilingual", language: "English", label: "German and English", downloadedBy: [{ deviceId: "ipad", name: "iPad" }] }),
        doc({ id: "d3", bookId: "b2", title: "Candide", bookLanguage: "fr" }),
      ],
      "phone",
    );
    expect(books.map((b) => [b.id, b.language, b.editions.map((e) => [e.documentId, e.downloaded])])).toEqual([
      ["b1", "German", [["d1", true], ["d2", false]]],
      ["b2", "French", [["d3", false]]],
    ]);
  });

  it("marks nothing downloaded for the public, which has no device", () => {
    const [book] = groupByBook([doc({ id: "d1", downloadedBy: [{ deviceId: "phone", name: "Petur's iPhone" }] })], null);
    expect(book?.editions[0]?.downloaded).toBe(false);
  });

  it("flattens the recorded narration onto each edition, and says so when there is none yet", () => {
    const [book] = groupByBook(
      [
        doc({ id: "d1", narration: { original: { level: "word", durationMs: 8400000, voice: "Thorsten" }, translation: null } }),
        doc({ id: "d2", format: "epub-bilingual", language: "English", narration: null }),
      ],
      "phone",
    );
    expect(book?.editions.map((e) => [e.narrated, e.durationMs, e.voice, e.level, e.levels])).toEqual([
      [true, 8400000, "Thorsten", "word", { source: "word", target: null }],
      [false, null, null, null, { source: null, target: null }],
    ]);
  });
});
