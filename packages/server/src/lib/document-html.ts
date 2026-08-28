export type DocumentChapter = {
  index: number;
  title: string;
  text: string;
  originalTitle: string;
  originalText: string;
};

type RenderDocumentHtmlOptions = {
  bookTitle: string;
  chapters: DocumentChapter[];
};

// Title dedup: the chapter title often repeats as the body's first line. Detected on
// the ORIGINAL side (garble-proof: both sides carry the same OCR noise), then the
// first block of whichever text is rendered gets dropped.
export function titleRepeatsAsFirstLine(originalTitle: string, originalText: string): boolean {
  const title = normalizeForComparison(originalTitle);
  if (!title) return false;
  const firstLine = normalizeForComparison(originalText.split("\n", 1)[0] ?? "");
  if (!firstLine) return false;
  return firstLine === title || firstLine.startsWith(title) || title.startsWith(firstLine);
}

export function renderDocumentHtml({ bookTitle, chapters }: RenderDocumentHtmlOptions): string {
  const language = inferDocumentLanguage(chapters);
  const tocEntries: string[] = [];
  const sections: string[] = [];

  for (const ch of chapters) {
    const id = `ch-${ch.index}`;
    const title = ch.title.trim() || `Chapter ${ch.index + 1}`;
    const dropFirstBlock = titleRepeatsAsFirstLine(ch.originalTitle, ch.originalText);
    tocEntries.push(`<li><a href="#${id}">${escapeHtml(title)}</a></li>`);
    sections.push(
      `<section class="chapter" id="${id}">\n<h1>${escapeHtml(title)}</h1>\n${renderChapterBody(ch.text, dropFirstBlock)}\n</section>`,
    );
  }

  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(bookTitle)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<div class="cover"><h1>${escapeHtml(bookTitle)}</h1></div>
<nav class="toc" role="doc-toc"><h1>Contents</h1><ol>
${tocEntries.join("\n")}
</ol></nav>
${sections.join("\n")}
</body>
</html>`;
}

// Translated text keeps light markdown from the source (headings, bold, italic);
// render those faithfully instead of showing the raw markers.
function renderChapterBody(text: string, dropFirstBlock: boolean): string {
  let blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (dropFirstBlock && blocks.length > 1) blocks = blocks.slice(1);
  return blocks.map(renderBlock).join("\n");
}

function renderBlock(block: string): string {
  const [, hashes, headingText] = block.match(/^(#{1,6})\s+([\s\S]*)$/) ?? [];
  if (hashes !== undefined && headingText !== undefined) {
    const level = Math.min(hashes.length + 1, 3); // h1 is the chapter title
    return `<h${level}>${renderInline(headingText)}</h${level}>`;
  }
  return `<p>${renderInline(block)}</p>`;
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
}

function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function inferDocumentLanguage(chapters: DocumentChapter[]): string {
  const sample = chapters.map((ch) => ch.text.slice(0, 2000)).join(" ");
  const cyrillic = sample.match(/[Ѐ-ӿ]/g)?.length ?? 0;
  const latin = sample.match(/[A-Za-z]/g)?.length ?? 0;
  if (cyrillic > latin * 2 && cyrillic > 20) return "bg";
  if (latin > cyrillic * 2 && latin > 20) return "en";
  return "und";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PRINT_CSS = `
@page {
  size: A5;
  margin: 18mm 16mm 20mm 16mm;
  @bottom-center { content: counter(page); font-size: 8.5pt; color: #444; }
}
@page :left {
  @top-left { content: string(book-title); font-size: 8pt; letter-spacing: 0.06em; color: #666; }
}
@page :right {
  @top-right { content: string(chapter-title); font-size: 8pt; font-style: italic; color: #666; }
}
@page cover { @bottom-center { content: none; } @top-left { content: none; } @top-right { content: none; } }
html { font-family: "Georgia", "Times New Roman", serif; font-size: 10.5pt; line-height: 1.45; }
body { margin: 0; }
.cover { page: cover; break-after: page; text-align: center; margin-top: 40mm; }
.cover h1 { font-size: 22pt; string-set: book-title content(); }
nav.toc { break-after: page; }
nav.toc h1 { font-size: 14pt; }
nav.toc ol { list-style: none; padding: 0; margin: 0; }
nav.toc li { margin: 0.35em 0; }
nav.toc a { text-decoration: none; color: inherit; }
nav.toc a::after { content: leader(dotted) " " target-counter(attr(href url), page); }
section.chapter { break-before: page; }
section.chapter h1 { font-size: 14pt; margin: 0 0 1.2em; string-set: chapter-title content(); }
section.chapter h2 { font-size: 12pt; }
section.chapter h3 { font-size: 10.5pt; }
p { margin: 0; text-indent: 1.3em; text-align: justify; hyphens: auto; orphans: 2; widows: 2; }
h1 + p, h2 + p, h3 + p { text-indent: 0; }
`;
