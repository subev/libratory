import type { LibraryFilter } from "../../lib/library-filter.ts";
import { IconClose } from "../icons.tsx";
import { useLibraryLayout } from "./LibraryShell.tsx";

const CHIPS: { id: LibraryFilter; label: string; title: string }[] = [
  { id: "all", label: "All", title: "Every book in this folder" },
  { id: "working", label: "Working", title: "Something is running — extracting, narrating, translating, cleaning up or assembling" },
  { id: "attention", label: "Needs attention", title: "Failed, or a PDF that produced no text" },
  { id: "done", label: "Ready to read", title: "Every chapter narrated, nothing in flight" },
];

export function LibraryFilters({
  filter,
  onFilter,
  counts,
  search,
  onSearch,
  showing,
}: {
  filter: LibraryFilter;
  onFilter: (next: LibraryFilter) => void;
  counts: Record<LibraryFilter, number>;
  search: string;
  onSearch: (next: string) => void;
  /** Null while searching: the chips describe this folder, the search crosses all of them. */
  showing: string | null;
}) {
  const layout = useLibraryLayout();
  const searching = search.trim().length > 0;
  // "Ready to read" is the longest chip and the least urgent, so it is the one the width takes
  const chips = layout.showLabels ? CHIPS : CHIPS.filter((c) => c.id !== "done");

  return (
    <div className="flex items-center gap-2 h-10 px-4 border-b border-(--border)">
      {!searching &&
        chips.map((chip) => {
          const active = chip.id === filter;
          return (
            // button-ok: a filter chip is a pill that fills when it is on; no Button variant is
            // round, and the counted label is part of the control rather than beside it.
            <button
              key={chip.id}
              onClick={() => onFilter(chip.id)}
              title={chip.title}
              aria-pressed={active}
              className={`px-2.5 py-1 rounded-full border text-xs font-semibold whitespace-nowrap cursor-pointer ${
                active
                  ? "border-(--accent) bg-(--accent-subtle) text-(--accent-text)"
                  : "border-(--border-input) text-(--text-secondary) hover:bg-(--bg-subtle) hover:text-(--text-primary)"
              }`}
              data-testid={`library-filter-${chip.id}`}
            >
              {chip.label} {counts[chip.id]}
            </button>
          );
        })}
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
