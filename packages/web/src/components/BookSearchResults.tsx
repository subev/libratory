import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router";
import { trpc } from "../trpc.ts";
import { IconFolder } from "./icons.tsx";

export function BookSearchResults({ query }: { query: string }) {
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results } = trpc.books.search.useQuery(
    { query: debounced },
    { placeholderData: (prev) => prev },
  );

  if (!results) {
    return <p className="text-(--text-muted) py-4">Searching…</p>;
  }
  if (results.length === 0) {
    return <p className="text-(--text-muted) py-4">No books match "{query}".</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-(--text-faint)">
        {results.length === 50 ? "First 50 matches" : `${results.length} match${results.length === 1 ? "" : "es"}`} across all folders
      </p>
      <div className="rounded-lg border border-(--border) bg-(--bg-card) divide-y divide-(--divide)" data-testid="search-results">
        {results.map((book) => (
          <div key={book.id} className="px-4 py-3 flex items-center gap-3">
            <div className="min-w-0">
              <Link to={`/books/${book.id}`} className="text-(--accent-text) hover:text-(--accent-text-hover) font-medium">
                {book.title}
              </Link>
              {book.kind === "digest" && (
                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--bg-subtle) text-(--text-secondary) align-middle" title="Digest — AI summary chapters from other books">
                  digest
                </span>
              )}
              <div className="text-xs text-(--text-faint)">
                <Link to="/" className="hover:text-(--text-secondary)">Home</Link>
                {book.folderPath.map((f) => (
                  <Fragment key={f.id}>
                    {" / "}
                    <Link to={`/folders/${f.id}`} className="inline-flex items-center gap-1 hover:text-(--text-secondary)"><IconFolder className="h-3 w-3 shrink-0" />{f.name}</Link>
                  </Fragment>
                ))}
              </div>
            </div>
            <span className="ml-auto shrink-0 text-sm tabular-nums text-(--text-tertiary)">
              {new Date(book.createdAt).toLocaleDateString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
