import { describe, expect, it } from "vitest";

import { renderChapterDocuments, renderDocumentHtml, titleRepeatsAsFirstLine } from "./document-html.ts";

describe("titleRepeatsAsFirstLine", () => {
  it("matches when the first line equals the title modulo punctuation and case", () => {
    expect(titleRepeatsAsFirstLine(
      "б) Втьшняя дтьятельность катом.",
      "б) Втьшняя дтьятельность катом.\n\nСистема скрытаго противодійствія.",
    )).toBe(true);
  });

  it("matches garbled OCR titles where one side is a prefix of the other", () => {
    expect(titleRepeatsAsFirstLine(
      ", І ' 4 І І › _ Г Л АВд А ХІІ.",
      ", І ' 4 І І › _ Г Л АВд А ХІІ. и еще текст\n\nтело главы",
    )).toBe(true);
  });

  it("does not match when the body starts with different text", () => {
    expect(titleRepeatsAsFirstLine(
      "The Great Assembly",
      "By virtue of the charter of Artaxerxes, Ezra gathered a new party.",
    )).toBe(false);
  });

  it("does not match empty titles or bodies", () => {
    expect(titleRepeatsAsFirstLine("", "Some text")).toBe(false);
    expect(titleRepeatsAsFirstLine("Title", "")).toBe(false);
    expect(titleRepeatsAsFirstLine("...", "...\n\nbody")).toBe(false);
  });
});

describe("renderDocumentHtml", () => {
  const chapter = (overrides: Partial<Parameters<typeof renderDocumentHtml>[0]["chapters"][0]> = {}) => ({
    index: 0,
    title: "Chapter One",
    text: "First paragraph.\n\nSecond paragraph.",
    originalTitle: "Chapter One",
    originalText: "Body starts differently.",
    ...overrides,
  });

  it("renders cover, TOC with target links, and chapter sections", () => {
    const html = renderDocumentHtml({
      bookTitle: "My Book",
      chapters: [chapter(), chapter({ index: 1, title: "Chapter Two", text: "More text." })],
    });

    expect(html).toMatch(/<div class="cover"><h1>My Book<\/h1><\/div>/);
    expect(html).toMatch(/<a href="#ch-0">Chapter One<\/a>/);
    expect(html).toMatch(/<a href="#ch-1">Chapter Two<\/a>/);
    expect(html).toMatch(/<section class="chapter" id="ch-0">/);
    expect(html).toMatch(/<h1>Chapter One<\/h1>/);
    expect(html).toMatch(/<p>First paragraph\.<\/p>/);
    expect(html).toMatch(/target-counter\(attr\(href url\), page\)/);
  });

  it("drops the first body block when the original title repeats as the first line", () => {
    const html = renderDocumentHtml({
      bookTitle: "My Book",
      chapters: [chapter({
        text: "**b) External Activity.**\n\nActual body text.",
        originalTitle: "б) Втьшняя дтьятельность.",
        originalText: "б) Втьшняя дтьятельность.\n\nтело",
      })],
    });

    expect(html).not.toMatch(/External Activity/);
    expect(html).toMatch(/<p>Actual body text\.<\/p>/);
  });

  it("keeps the first block when the original body does not repeat the title", () => {
    const html = renderDocumentHtml({
      bookTitle: "My Book",
      chapters: [chapter()],
    });

    expect(html).toMatch(/<p>First paragraph\.<\/p>/);
  });

  it("renders markdown remnants: headings, bold, italic", () => {
    const html = renderDocumentHtml({
      bookTitle: "My Book",
      chapters: [chapter({
        text: "# Section Heading\n\n## Subsection\n\n**bold text** and *italic words* here.",
      })],
    });

    expect(html).toMatch(/<h2>Section Heading<\/h2>/);
    expect(html).toMatch(/<h3>Subsection<\/h3>/);
    expect(html).toMatch(/<strong>bold text<\/strong>/);
    expect(html).toMatch(/<em>italic words<\/em>/);
  });

  it("escapes HTML in titles and body text", () => {
    const html = renderDocumentHtml({
      bookTitle: "Book <One> & Co",
      chapters: [chapter({ title: "A & B", text: "2 < 3 & 4 > 1" })],
    });

    expect(html).toMatch(/<title>Book &lt;One&gt; &amp; Co<\/title>/);
    expect(html).toMatch(/<a href="#ch-0">A &amp; B<\/a>/);
    expect(html).toMatch(/<p>2 &lt; 3 &amp; 4 &gt; 1<\/p>/);
  });

  it("sets the document language from the rendered text", () => {
    const english = renderDocumentHtml({
      bookTitle: "Book",
      chapters: [chapter({ text: "This is a long enough English paragraph for detection to work." })],
    });
    const bulgarian = renderDocumentHtml({
      bookTitle: "Книга",
      chapters: [chapter({ text: "Това е достатъчно дълъг български абзац за разпознаване на езика." })],
    });

    expect(english).toMatch(/<html lang="en">/);
    expect(bulgarian).toMatch(/<html lang="bg">/);
  });

  it("falls back to a numbered title when the chapter title is blank", () => {
    const html = renderDocumentHtml({
      bookTitle: "Book",
      chapters: [chapter({ index: 4, title: "  " })],
    });

    expect(html).toMatch(/<h1>Chapter 5<\/h1>/);
  });
});

describe("renderChapterDocuments", () => {
  const chapter = (overrides: Partial<Parameters<typeof renderDocumentHtml>[0]["chapters"][0]> = {}) => ({
    index: 0,
    title: "Chapter One",
    text: "First paragraph.\n\nSecond paragraph.",
    originalTitle: "Chapter One",
    originalText: "Body starts differently.",
    ...overrides,
  });

  // One entry per file is what Vivliostyle turns into one spine item each; a single document came
  // out of the CLI as an EPUB with one chapter and no navigation.
  it("gives every chapter its own file and title", () => {
    const docs = renderChapterDocuments({
      bookTitle: "My Book",
      chapters: [chapter(), chapter({ index: 1, title: "Chapter Two", text: "More text." })],
    });

    expect(docs.map((doc) => doc.filename)).toEqual(["chapter-0001.html", "chapter-0002.html"]);
    expect(docs.map((doc) => doc.title)).toEqual(["Chapter One", "Chapter Two"]);
    expect(docs[0]!.html).toMatch(/<h1>Chapter One<\/h1>/);
    expect(docs[0]!.html).toMatch(/<p>First paragraph\.<\/p>/);
    expect(docs[0]!.html).not.toMatch(/More text/);
    expect(docs[1]!.html).toMatch(/<p>More text\.<\/p>/);
  });

  it("titles an untitled chapter by its number, and drops a title that repeats as the first line", () => {
    const docs = renderChapterDocuments({
      bookTitle: "My Book",
      chapters: [chapter({
        index: 4,
        title: "   ",
        text: "Chapter Five\n\nActual body text.",
        originalTitle: "Chapter Five",
        originalText: "Chapter Five\n\nActual body text.",
      })],
    });

    expect(docs[0]!.title).toBe("Chapter 5");
    expect(docs[0]!.html).toMatch(/<p>Actual body text\.<\/p>/);
    expect(docs[0]!.html).not.toMatch(/<p>Chapter Five<\/p>/);
  });
});
