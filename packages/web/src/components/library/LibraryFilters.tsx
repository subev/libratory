import type { LibraryFilter } from "../../lib/library-filter.ts";
import { IconClose } from "../icons.tsx";
import { PillToggle } from "../PillToggle.tsx";
import { useLibraryLayout } from "./LibraryShell.tsx";

const CHIPS: { id: LibraryFilter; label: string; short: string; title: string }[] = [
  { id: "all", label: "All", short: "All", title: "Every book in this folder" },
  { id: "working", label: "Working", short: "Working", title: "Something is running — extracting, narrating, translating, cleaning up or assembling" },
  { id: "attention", label: "Needs attention", short: "Attention", title: "Failed, or a PDF that produced no text" },
  { id: "ready", label: "Ready to read", short: "Ready", title: "Every chapter narrated, nothing in flight" },
];

export function LibraryFilters({
  filter,
  onFilter,
  counts,
  search,
  onSearch,
}: {
  filter: LibraryFilter;
  onFilter: (next: LibraryFilter) => void;
  counts: Record<LibraryFilter, number>;
  search: string;
  onSearch: (next: string) => void;
}) {
  const layout = useLibraryLayout();
  const searching = search.trim().length > 0;
  const showing = counts[filter] === counts.all ? null : `Showing ${counts[filter]} of ${counts.all}`;
  // Narrow, the labels shorten rather than a chip dropping out: a hidden chip leaves its own filter
  // applied with nothing showing it is on and no way to switch it off.

  return (
    <div className="flex items-center gap-2 h-10 px-4 border-b border-(--border)">
      {!searching &&
        CHIPS.map((chip) => (
          <PillToggle
            key={chip.id}
            selected={chip.id === filter}
            onClick={() => onFilter(chip.id)}
            title={chip.title}
            testId={`library-filter-${chip.id}`}
          >
            {layout.showLabels ? chip.label : chip.short} {counts[chip.id]}
          </PillToggle>
        ))}
      {!searching && <div className="w-px h-4 bg-(--border)" />}
      <div className="relative">
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onSearch(""); }}
          placeholder="Search all books…"
          className={`${layout.showLabels ? "w-52" : "w-32"} pl-3 pr-8 py-1 text-xs rounded-md border border-(--border-input) bg-(--bg-card) text-(--text-primary) outline-none`}
          data-testid="book-search"
        />
        {searching && (
          <button
            onClick={() => onSearch("")}
            title="Clear the search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-(--text-faint) hover:text-(--text-secondary) cursor-pointer"
            data-testid="clear-search"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1" />
      <span className="text-xs text-(--text-faint)">
        {searching ? "Searching every book, in every folder" : showing}
      </span>
    </div>
  );
}
