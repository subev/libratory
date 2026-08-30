export type ChapterReaderSourceBlock = {
  type: string;
  text: string;
  page: number;
  included: boolean;
  level?: number;
};

type RenderChapterReaderHtmlOptions = {
  bookTitle: string;
  chapterTitle: string;
  pageStart: number | null;
  pageEnd: number | null;
  sourceBlocks: ChapterReaderSourceBlock[];
};

export function renderChapterReaderHtml({
  bookTitle,
  chapterTitle,
  pageStart,
  pageEnd,
  sourceBlocks,
}: RenderChapterReaderHtmlOptions): string {
  const language = inferDocumentLanguage(bookTitle, chapterTitle, sourceBlocks);
  const escapedBookTitle = escapeHtml(bookTitle);
  const escapedChapterTitle = escapeHtml(chapterTitle);
  const documentTitle = `${chapterTitle} - ${bookTitle}`;
  const escapedDocumentTitle = escapeHtml(documentTitle);
  const pageLabel = formatPageLabel(pageStart, pageEnd);
  const description = buildDescription(sourceBlocks);
  const escapedDescription = escapeHtml(description);
  const body = renderSourceBlocks(sourceBlocks);
  const schema = escapeScriptJson({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: chapterTitle,
    isPartOf: {
      "@type": "Book",
      name: bookTitle,
    },
    inLanguage: language,
    articleSection: chapterTitle,
    description,
  });

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapedDocumentTitle}</title>
  <meta name="description" content="${escapedDescription}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="${escapedBookTitle}" />
  <meta property="og:title" content="${escapedChapterTitle}" />
  <meta property="og:description" content="${escapedDescription}" />
  <script type="application/ld+json">${schema}</script>
  <!-- Same origin as the app, so the appearance pinned there reaches this page too. -->
  <script>try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
  <style>
    :root {
      color-scheme: light dark;
    }

    :root[data-theme="light"] {
      color-scheme: light;
    }

    :root[data-theme="dark"] {
      color-scheme: dark;
    }

    body {
      margin: 0;
      background: light-dark(#f4f4f5, #09090b);
      color: light-dark(#18181b, #e4e4e7);
      font: 19px/1.7 Georgia, serif;
    }

    main {
      padding: 32px 16px 64px;
    }

    article {
      max-width: 760px;
      margin: 0 auto;
      padding: 40px;
      background: light-dark(#ffffff, #18181b);
      border-radius: 18px;
      box-shadow: 0 10px 30px light-dark(rgba(24, 24, 27, 0.08), transparent);
    }

    header {
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid light-dark(#e4e4e7, #3f3f46);
    }

    .eyebrow {
      margin: 0 0 10px;
      color: light-dark(#52525b, #a1a1aa);
      font: 600 13px/1.4 system-ui, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .meta {
      margin: 10px 0 0;
      color: light-dark(#71717a, #a1a1aa);
      font: 14px/1.5 system-ui, sans-serif;
    }

    h1, h2, h3, h4, h5, h6 {
      color: light-dark(#09090b, #fafafa);
      line-height: 1.25;
    }

    h1 {
      margin: 0;
      font-size: 2.2rem;
    }

    h2, h3, h4, h5, h6 {
      margin: 2em 0 0.7em;
      font-size: 1.35rem;
    }

    p, ul {
      margin: 0 0 1em;
    }

    ul {
      padding-left: 1.4em;
    }

    li + li {
      margin-top: 0.35em;
    }

  </style>
</head>
<body>
  <main>
    <article itemscope itemtype="https://schema.org/Article" aria-label="${escapedChapterTitle}">
      <header>
        <p class="eyebrow">${escapedBookTitle}</p>
        <h1 itemprop="headline">${escapedChapterTitle}</h1>
        ${pageLabel ? `<p class="meta">${pageLabel}</p>` : ""}
      </header>
      <section itemprop="articleBody">
        ${body}
      </section>
    </article>
  </main>
</body>
</html>`;
}

function renderSourceBlocks(sourceBlocks: ChapterReaderSourceBlock[]): string {
  const parts: string[] = [];
  const listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    parts.push(`<ul>${listItems.join("")}</ul>`);
    listItems.length = 0;
  };

  for (const block of sourceBlocks) {
    if (!block.included) continue;

    const text = block.text.trim();
    if (!text) continue;

    if (block.type === "ListItem") {
      listItems.push(`<li>${escapeHtml(text)}</li>`);
      continue;
    }

    flushList();

    if (block.type === "SectionHeader") {
      const level = Math.max(2, Math.min(6, (block.level ?? 1) + 1));
      parts.push(`<h${level}>${escapeHtml(text)}</h${level}>`);
      continue;
    }

    parts.push(`<p>${escapeHtml(text)}</p>`);
  }

  flushList();

  return parts.join("\n");
}

function formatPageLabel(pageStart: number | null, pageEnd: number | null): string | null {
  if (pageStart === null) return null;
  if (pageEnd === null || pageEnd === pageStart) return `Page ${pageStart}`;
  return `Pages ${pageStart}-${pageEnd}`;
}

function buildDescription(sourceBlocks: ChapterReaderSourceBlock[]): string {
  const text = sourceBlocks
    .filter((block) => block.included)
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text.slice(0, 220) || "Chapter reader view";
}

function inferDocumentLanguage(
  bookTitle: string,
  chapterTitle: string,
  sourceBlocks: ChapterReaderSourceBlock[],
): string {
  const sample = [bookTitle, chapterTitle]
    .concat(sourceBlocks.filter((block) => block.included).map((block) => block.text))
    .join(" ");

  const cyrillicCount = countMatches(sample, /[\u0400-\u04FF]/g);
  const latinCount = countMatches(sample, /[A-Za-z]/g);

  if (cyrillicCount > latinCount * 2 && cyrillicCount > 20) return "bg";
  if (latinCount > cyrillicCount * 2 && latinCount > 20) return "en";
  return "und";
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
