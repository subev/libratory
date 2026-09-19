import { Link } from "react-router";

import { IconBook, IconDocument, IconExternal } from "../icons.tsx";

export type ChatSource = {
  id: string;
  chunkId: string;
  kind: "raw" | "chapter" | "translation";
  bookId: string;
  bookTitle: string;
  fileId: string | null;
  page: number | null;
  chapterId: string | null;
  chapterTitle: string | null;
  language: string | null;
  chapterIndex?: number | null;
  snippet?: string;
  readAt?: number | null;
};

type OpenPdf = (args: { fileId: string; page?: number; filename?: string }) => void;

// The reader at the moment the passage is spoken, when the chapter is narrated
function readerLink(source: ChatSource): string | null {
  if (source.readAt == null || source.chapterIndex == null) return null;
  return `/books/${source.bookId}/read?chapter=${source.chapterIndex}&t=${Math.round(source.readAt)}`;
}

function bookLink(source: ChatSource): string {
  const params = new URLSearchParams();
  if (source.kind === "translation" && source.language) params.set("variant", source.language);
  if (source.chapterId) params.set("chapter", source.chapterId);
  const query = params.toString();
  return `/books/${source.bookId}${query ? `?${query}` : ""}`;
}

function where(source: ChatSource): string {
  const parts: string[] = [];
  if (source.chapterTitle) parts.push(source.chapterTitle);
  if (source.page != null) parts.push(`p. ${source.page}`);
  return parts.join(" · ") || "Whole-book text";
}

const rowClass =
  "flex min-w-0 flex-1 items-baseline gap-2 rounded px-2 py-1 text-left text-xs text-(--text-muted) hover:bg-(--bg-card-hover) hover:text-(--text-primary) cursor-pointer";
const targetClass = "ml-auto inline-flex shrink-0 items-center gap-1 self-center text-[11px] text-(--accent-text)";

// Numbered like the [n] markers in the answer, grouped under the book so its title is said once,
// and told apart by how each passage starts — a dozen citations of one chapter used to be a dozen
// identical truncated pills.
export function SourceList({ sources, onOpenPdf }: { sources: ChatSource[]; onOpenPdf: OpenPdf }) {
  if (sources.length === 0) return null;

  const numbered = sources.map((source, i) => ({ source, n: i + 1 }));
  const bookIds = [...new Set(sources.map((source) => source.bookId))];

  return (
    <div className="mt-2 space-y-2" data-testid="chat-sources">
      {bookIds.map((bookId) => {
        const rows = numbered.filter((row) => row.source.bookId === bookId);
        return (
          <div key={bookId}>
            <p className="px-2 text-xs font-medium text-(--text-secondary)">{rows[0]?.source.bookTitle}</p>
            <ul>
              {rows.map(({ source, n }) => (
                <li key={source.id} className="flex items-center gap-1">
                  <SourceRow source={source} n={n} onOpenPdf={onOpenPdf} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function SourceRow({ source, n, onOpenPdf }: { source: ChatSource; n: number; onOpenPdf: OpenPdf }) {
  const reader = readerLink(source);
  const fileId = source.fileId;
  const openPdf = fileId
    ? () => onOpenPdf({
        fileId,
        page: source.page ?? undefined,
        filename: [source.bookTitle, source.chapterTitle].filter(Boolean).join(" — "),
      })
    : null;

  const body = (
    <>
      <span className="w-5 shrink-0 text-right font-medium tabular-nums">{n}.</span>
      <span className="min-w-0">
        <span className="block truncate text-(--text-secondary)">
          {where(source)}
          {source.kind === "translation" && source.language && (
            <span className="ml-1.5 text-[10px] font-semibold uppercase text-(--text-muted)">{source.language}</span>
          )}
        </span>
        {source.snippet && <span className="block truncate text-(--text-faint)">{source.snippet}</span>}
      </span>
    </>
  );

  if (reader) {
    return (
      <>
        {/* button-ok: a citation row — a numbered two-line list entry, not an action button */}
        <Link to={reader} target="_blank" rel="noopener noreferrer" className={rowClass} data-testid="chat-source-read">
          {body}
          <span className={targetClass}><IconBook className="h-3 w-3" /> Read</span>
        </Link>
        {openPdf && (
          <button
            onClick={openPdf}
            title="Open the PDF at this page"
            className="shrink-0 text-[11px] text-(--text-faint) hover:text-(--text-secondary)"
          >
            PDF
          </button>
        )}
      </>
    );
  }

  if (openPdf) {
    return (
      // button-ok: a citation row — a numbered two-line list entry, not an action button
      <button onClick={openPdf} className={rowClass} data-testid="chat-source-pdf">
        {body}
        <span className={targetClass}><IconDocument className="h-3 w-3" /> PDF</span>
      </button>
    );
  }

  return (
    // button-ok: a citation row — a numbered two-line list entry, not an action button
    <Link to={bookLink(source)} target="_blank" rel="noopener noreferrer" className={rowClass}>
      {body}
      <span className={targetClass}><IconExternal className="h-3 w-3" /> Book</span>
    </Link>
  );
}
