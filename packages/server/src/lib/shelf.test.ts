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
    downloadedBy: [],
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
});
