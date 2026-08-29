import { Link } from "react-router";

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
};

export function sourceLabel(source: ChatSource): string {
  const parts = [source.bookTitle];
  if (source.chapterTitle) parts.push(source.chapterTitle);
  if (source.page != null) parts.push(`p. ${source.page}`);
  return parts.join(" — ");
}

export function SourceChips({
  sources,
  onOpenPdf,
}: {
  sources: ChatSource[];
  onOpenPdf: (args: { fileId: string; page?: number; filename?: string }) => void;
}) {
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2" data-testid="chat-sources">
      {sources.map((source, i) => {
        const label = sourceLabel(source);
        const chipClass =
          "inline-flex items-center gap-1 max-w-72 text-xs px-2 py-1 rounded-full bg-(--bg-subtle) text-(--text-muted) hover:text-(--text-primary) hover:bg-(--bg-card-hover) border border-(--border) cursor-pointer";
        const badge = source.kind === "translation" && source.language ? (
          <span className="uppercase text-[10px] font-semibold text-(--text-muted) shrink-0">{source.language}</span>
        ) : null;
        const inner = (
          <>
            <span className="font-medium shrink-0">{i + 1}.</span>
            <span className="truncate" title={label}>{label}</span>
            {badge}
          </>
        );
        const chapterParam = source.chapterId ? `chapter=${source.chapterId}` : "";
        if (source.fileId) {
          return (
            // button-ok: a citation chip — numbered, truncating and pill-shaped; its own primitive
            <button
              key={source.id}
              onClick={() => onOpenPdf({ fileId: source.fileId!, page: source.page ?? undefined, filename: source.bookTitle })}
              className={chipClass}
            >
              {inner}
            </button>
          );
        }
        const variantParam =
          source.kind === "translation" && source.language
            ? `variant=${encodeURIComponent(source.language)}`
            : "";
        const query = [variantParam, chapterParam].filter(Boolean).join("&");
        return (
          // button-ok: a citation chip — numbered, truncating and pill-shaped; its own primitive
          <Link
            key={source.id}
            to={`/books/${source.bookId}${query ? `?${query}` : ""}`}
            target="_blank"
            rel="noopener noreferrer"
            className={chipClass}
          >
            {inner}
          </Link>
        );
      })}
    </div>
  );
}
