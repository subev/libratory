import { describe, expect, it } from "vitest";

import { renderChapterReaderHtml } from "./chapter-reader.ts";

describe("renderChapterReaderHtml", () => {
  it("renders a reader-friendly article from source blocks", () => {
    const html = renderChapterReaderHtml({
      bookTitle: "Sample Book",
      chapterTitle: "Sample Chapter",
      pageStart: 1,
      pageEnd: 3,
      sourceBlocks: [
        { type: "SectionHeader", text: "Origins", page: 1, included: true, level: 1 },
        { type: "Text", text: "First paragraph.", page: 1, included: true },
        { type: "ListItem", text: "First bullet", page: 1, included: true },
        { type: "ListItem", text: "Second bullet", page: 1, included: true },
        { type: "Text", text: "Closing paragraph.", page: 2, included: true },
        { type: "PageHeader", text: "Ignored header", page: 2, included: false },
      ],
    });

    expect(html).toMatch(/<article[^>]*>/);
    expect(html).toMatch(/<h1[^>]*>Sample Chapter<\/h1>/);
    expect(html).toMatch(/<h2>Origins<\/h2>/);
    expect(html).toMatch(/<p>First paragraph\.<\/p>/);
    expect(html).toMatch(/<ul>\s*<li>First bullet<\/li>\s*<li>Second bullet<\/li>\s*<\/ul>/s);
    expect(html).toMatch(/<p>Closing paragraph\.<\/p>/);
    expect(html).not.toMatch(/Ignored header/);
  });

  it("escapes source block text before rendering", () => {
    const html = renderChapterReaderHtml({
      bookTitle: "Book <One>",
      chapterTitle: "Chapter & One",
      pageStart: null,
      pageEnd: null,
      sourceBlocks: [
        { type: "Text", text: "2 < 3 & 4 > 1", page: 1, included: true },
      ],
    });

    expect(html).toMatch(/<title>Chapter &amp; One - Book &lt;One&gt;<\/title>/);
    expect(html).toMatch(/<h1[^>]*>Chapter &amp; One<\/h1>/);
    expect(html).toMatch(/<p>2 &lt; 3 &amp; 4 &gt; 1<\/p>/);
  });

  it("follows the appearance pinned in the app", () => {
    const html = renderChapterReaderHtml({
      bookTitle: "Sample Book",
      chapterTitle: "Sample Chapter",
      pageStart: null,
      pageEnd: null,
      sourceBlocks: [{ type: "Text", text: "Body.", page: 1, included: true }],
    });

    expect(html).toContain('localStorage.getItem("theme")');
    expect(html).toMatch(/:root\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
    expect(html).toContain("background: light-dark(#f4f4f5, #09090b)");
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("adds article metadata and Bulgarian language hints for Cyrillic chapters", () => {
    const html = renderChapterReaderHtml({
      bookTitle: "Изгонени",
      chapterTitle: "Произходът на злото",
      pageStart: 1,
      pageEnd: 14,
      sourceBlocks: [
        { type: "Text", text: "Това е дълъг български абзац за тестване на reader mode.", page: 1, included: true },
        { type: "Text", text: "Той трябва да помогне на браузъра да разпознае страницата като статия.", page: 1, included: true },
      ],
    });

    expect(html).toMatch(/<html lang="bg">/);
    expect(html).toMatch(/<title>Произходът на злото - Изгонени<\/title>/);
    expect(html).toMatch(/<meta name="description" content="Това е дълъг български абзац за тестване на reader mode\./);
    expect(html).toMatch(/<meta property="og:type" content="article" \/>/);
    expect(html).toMatch(/<meta property="og:site_name" content="Изгонени" \/>/);
    expect(html).toMatch(/<script type="application\/ld\+json">/);
    expect(html).toMatch(/"@type":"Article"/);
    expect(html).toMatch(/<article[^>]*itemscope[^>]*itemtype="https:\/\/schema.org\/Article"/);
    expect(html).toMatch(/itemprop="articleBody"/);
  });
});
