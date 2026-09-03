import { useState, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "./Button.tsx";
import { PillToggle } from "./PillToggle.tsx";
import { Menu } from "./Menu.tsx";
import { useShellLayout } from "./book/BookShell.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { ChapterModal } from "./ChapterModal.tsx";
import { chapterAudioDownload, chapterAudioUrl, SYNTH_BUSY, variantLabel } from "../lib/chapters.ts";
import { ChapterAiModal } from "./ChapterAiModal.tsx";
import { PdfPreviewModal } from "./PdfPreviewModal.tsx";
import { SynthesizeModal, type SynthSettings } from "./SynthesizeModal.tsx";
import {
  IconAi,
  IconBook,
  IconClose,
  IconContinue,
  IconDownload,
  IconDragHandle,
  IconExpand,
  IconExternal,
  IconPause,
  IconPlay,
  IconRefresh,
  IconRename,
} from "./icons.tsx";

export type ChapterRow = {
  id: string;
  index: number;
  title: string;
  status: string;
  error: string | null;
  wordCount: number;
  durationMs: number | null;
  audioPath: string | null;
  hasCleanText: boolean;
  hasCustomText: boolean;
  hasSourceBlocks: boolean;
  progress: string | null;
  selected: boolean;
  pageStart: number | null;
  pageEnd: number | null;
  sourceFileIndex: number | null;
  source?: { kind: "book"; bookId: string; title: string } | { kind: "url"; url: string; title?: string } | { kind: "note"; noteId: string } | { kind: "api"; client?: string } | null;
  synthesizedWith: { voice?: string; speed?: number | null } | null;
  // Translation view: rows without a finished translation can't be synthesized (but can be selected for bulk translation)
  synthesizable?: boolean;
  audioUrl?: string;
  cleanup?: { status: "pending" | "cleaning" | "done" | "failed" | "suspended"; progress?: string; error?: string } | null;
};

export type VariantRef = {
  key: string;
  kind: "translation" | "transform";
  label: string | null;
};

export type FileInfo = {
  id: string;
  index: number;
  filename: string;
};

const STATUSES = ["done", "failed", "pending", "suspended", "synthesizing", "normalizing"] as const;

export function ChapterTable({
  language,
  bookId,
  chapters,
  files,
  onQueue,
  onRename,
  onReorder,
  onSetSelected,
  onSetAllSelected,
  onSetSelectedBatch,
  variant,
  variants,
  onSwitchVariant,
  synth,
}: {
  language?: string | null;
  bookId: string;
  chapters: ChapterRow[];
  files?: FileInfo[];
  onQueue: (id: string, resume?: boolean) => void;
  onRename?: (id: string, title: string) => void;
  onReorder?: (chapterIds: string[]) => void;
  onSetSelected: (id: string, selected: boolean) => void;
  onSetAllSelected: (selected: boolean) => void;
  onSetSelectedBatch: (ids: string[], selected: boolean) => void;
  // When set, the chapter modal shows this variant's text instead of the original
  variant?: VariantRef | null;
  variants?: VariantRef[];
  onSwitchVariant?: (key: string | null) => void;
  // Voice and speed the next synthesis will use for this view (variant lane or book)
  synth: SynthSettings;
}) {
  const [pickedChapterIndex, setPickedChapterIndex] = useState<number | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // A deep link (?chapter=<id>, e.g. from a chat citation) opens the modal on its own; the first
  // move away from it — another chapter, or closing — is what takes it back out of the URL.
  const deepLinked = searchParams.get("chapter");
  const deepLinkedIndex = deepLinked ? chapters.findIndex((c) => c.id === deepLinked) : -1;
  const modalChapterIndex = pickedChapterIndex ?? (deepLinkedIndex >= 0 ? deepLinkedIndex : null);
  const openChapterModal = (index: number | null) => {
    setPickedChapterIndex(index);
    // The updater form, and the has() check inside it: ?variant= and the shell's own param are
    // written from elsewhere, so the render's snapshot is neither safe to write back nor to read
    // the answer out of — a deep link that arrived since this render would survive the delete.
    setSearchParams(
      (current) => {
        if (!current.has("chapter")) return current;
        const next = new URLSearchParams(current);
        next.delete("chapter");
        return next;
      },
      { replace: true },
    );
  };

  const [aiChapter, setAiChapter] = useState<{ id: string; title: string } | null>(null);
  const [pdfPreview, setPdfPreview] = useState<{ fileId: string; page: number; filename?: string } | null>(null);
  const [synthesizeChapterId, setSynthesizeChapterId] = useState<string | null>(null);
  const toggleAllRef = useRef<HTMLInputElement>(null);
  const lastClickedFilteredIndex = useRef<number | null>(null);
  const [playingChapterId, setPlayingChapterId] = useState<string | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Filter state
  const [quickFilter, setQuickFilter] = useState<"all" | "noaudio" | "flight" | "attention">("all");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [statusOperator, setStatusOperator] = useState<"is" | "is_not">("is");
  const [wordCountMin, setWordCountMin] = useState("");
  const [wordCountMax, setWordCountMax] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [durationMax, setDurationMax] = useState("");
  const [durationUnit, setDurationUnit] = useState<"sec" | "min">("sec");
  const [sourceFileFilter, setSourceFileFilter] = useState("");
  const [dragChapterId, setDragChapterId] = useState<string | null>(null);
  const [dragOverChapterId, setDragOverChapterId] = useState<string | null>(null);

  const isMultiFile = files && files.length > 1;

  // Cheap enough to redo per render — there is no React Compiler here (esbuild JSX, no Babel pass)
  const matchesQuick = (ch: ChapterRow) => {
    if (quickFilter === "noaudio") return !ch.audioPath;
    if (quickFilter === "flight") return SYNTH_BUSY.includes(ch.status);
    // Failures only. "suspended" is what a deliberate cancel produces and what a note added as a
    // chapter is born as — neither is something the reader needs nagging about.
    if (quickFilter === "attention") return ch.status === "failed";
    return true;
  };

  const filteredChapters = chapters.filter((ch) => {
    if (!matchesQuick(ch)) return false;
    if (search && !ch.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter) {
      if (statusOperator === "is" && ch.status !== statusFilter) return false;
      if (statusOperator === "is_not" && ch.status === statusFilter) return false;
    }
    const minW = Number(wordCountMin);
    if (minW && ch.wordCount < minW) return false;
    const maxW = Number(wordCountMax);
    if (maxW && ch.wordCount > maxW) return false;
    const durationMultiplier = durationUnit === "min" ? 60000 : 1000;
    const minD = Number(durationMin) * durationMultiplier;
    if (minD && (ch.durationMs ?? 0) < minD) return false;
    const maxD = Number(durationMax) * durationMultiplier;
    if (maxD && (ch.durationMs ?? 0) > maxD) return false;
    if (sourceFileFilter && ch.sourceFileIndex !== Number(sourceFileFilter)) return false;
    return true;
  });

  const isFiltered = filteredChapters.length !== chapters.length;
  const canDrag = onReorder && !isFiltered;
  const activeFilterCount = [
    search,
    statusFilter,
    wordCountMin,
    wordCountMax,
    durationMin,
    durationMax,
    sourceFileFilter,
    quickFilter === "all" ? "" : quickFilter,
  ].filter(Boolean).length;
  const quickCounts = {
    all: chapters.length,
    noaudio: chapters.filter((c) => !c.audioPath).length,
    flight: chapters.filter((c) => SYNTH_BUSY.includes(c.status)).length,
    attention: chapters.filter((c) => c.status === "failed").length,
  };
  const layout = useShellLayout();

  // Checkbox state based on visible (filtered) chapters
  const visibleSelectedCount = filteredChapters.filter((c) => c.selected).length;
  const allVisibleSelected = filteredChapters.length > 0 && visibleSelectedCount === filteredChapters.length;
  const noneVisibleSelected = visibleSelectedCount === 0;

  useEffect(() => {
    if (toggleAllRef.current) {
      toggleAllRef.current.indeterminate = !allVisibleSelected && !noneVisibleSelected;
    }
  }, [allVisibleSelected, noneVisibleSelected]);

  function handleToggleAll() {
    if (isFiltered) {
      onSetSelectedBatch(filteredChapters.map((c) => c.id), !allVisibleSelected);
    } else {
      onSetAllSelected(!allVisibleSelected);
    }
  }

  function clearFilters() {
    setQuickFilter("all");
    setSearch("");
    setStatusFilter("");
    setStatusOperator("is");
    setWordCountMin("");
    setWordCountMax("");
    setDurationMin("");
    setDurationMax("");
    setDurationUnit("sec");
    setSourceFileFilter("");
  }

  const playingChapter = playingChapterId
    ? chapters.find((c) => c.id === playingChapterId) ?? null
    : null;

  function handlePlay(chapterId: string) {
    if (playingChapterId === chapterId) {
      if (audioRef.current?.paused) {
        audioRef.current.play();
      } else {
        audioRef.current?.pause();
      }
      return;
    }
    setPlayingChapterId(chapterId);
  }

  function handleStopPlayer() {
    audioRef.current?.pause();
    setPlayingChapterId(null);
    setIsAudioPlaying(false);
  }

  // Autoplay when switching chapters
  useEffect(() => {
    if (playingChapterId && audioRef.current) {
      audioRef.current.play().catch(() => {});
    }
  }, [playingChapterId]);

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Quick filters, a title search, and the rest behind a popover — a closed disclosure hid
          whether anything was filtered at all, which is worse in a popover than it was inline. */}
      <div className="flex items-center gap-2 mb-3 flex-wrap shrink-0">
        <PillToggle selected={quickFilter === "all"} onClick={() => setQuickFilter("all")} testId="chapter-filter-all">
          All {quickCounts.all}
        </PillToggle>
        <PillToggle
          selected={quickFilter === "noaudio"}
          onClick={() => setQuickFilter("noaudio")}
          title="Chapters with no audio yet"
          testId="chapter-filter-noaudio"
        >
          Needs audio {quickCounts.noaudio}
        </PillToggle>
        {layout.showLabels && (
          <PillToggle
            selected={quickFilter === "flight"}
            onClick={() => setQuickFilter("flight")}
            title="Queued, normalizing or synthesizing right now"
            testId="chapter-filter-flight"
          >
            In flight {quickCounts.flight}
          </PillToggle>
        )}
        <PillToggle
          selected={quickFilter === "attention"}
          onClick={() => setQuickFilter("attention")}
          title="Failed chapters — a cancelled one is not a failure"
          testId="chapter-filter-attention"
        >
          Needs attention {quickCounts.attention}
        </PillToggle>

        <div className="w-px h-4 bg-(--border)" />

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter titles…"
          aria-label="Filter chapter titles"
          className={`${layout.showLabels ? "w-42" : "w-27"} px-2.5 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)`}
          data-testid="chapter-search"
        />

        <Menu
          align="left"
          width={layout.filterColumns === 2 ? "w-128" : "w-80"}
          testId="chapter-filters"
          trigger={({ open, toggle }) => (
            // button-ok: a disclosure for the filter panel, skinned to sit with the pills beside it
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className={`flex items-center gap-1.5 h-6.5 px-2.5 rounded-md border text-xs font-semibold ${
                activeFilterCount > 0
                  ? "bg-(--accent-subtle) border-(--accent) text-(--accent-text)"
                  : "border-(--border-input) text-(--text-secondary) hover:bg-(--bg-subtle)"
              }`}
              data-testid="chapter-filters-trigger"
            >
              Filters
              {activeFilterCount > 0 && (
                <span className="px-1.5 rounded-full text-[10px] font-bold bg-(--accent) text-(--on-accent)">{activeFilterCount}</span>
              )}
            </button>
          )}
        >
          {(close) => (
            <div className="p-2">
              <div className={`grid gap-x-6 gap-y-3 ${layout.filterColumns === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-(--text-muted) w-16 shrink-0">Status</span>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <select
                      value={statusOperator}
                      onChange={(e) => setStatusOperator(e.target.value as "is" | "is_not")}
                      className="px-1.5 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)"
                    >
                      <option value="is">is</option>
                      <option value="is_not">is not</option>
                    </select>
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="flex-1 min-w-0 px-1.5 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)"
                    >
                      <option value="">All</option>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {isMultiFile && (
                  <label className="flex items-center gap-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-(--text-muted) w-16 shrink-0">Source</span>
                    <select
                      value={sourceFileFilter}
                      onChange={(e) => setSourceFileFilter(e.target.value)}
                      className="flex-1 min-w-0 px-1.5 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)"
                    >
                      <option value="">All files</option>
                      {files!.map((f) => (
                        <option key={f.index} value={String(f.index)}>
                          {f.index + 1}. {f.filename}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-(--text-muted) w-16 shrink-0">Words</span>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <input
                      type="number"
                      value={wordCountMin}
                      onChange={(e) => setWordCountMin(e.target.value)}
                      placeholder="min"
                      min={0}
                      className="w-full min-w-0 px-2 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) tabular-nums"
                    />
                    <span className="text-(--text-faint) text-xs">–</span>
                    <input
                      type="number"
                      value={wordCountMax}
                      onChange={(e) => setWordCountMax(e.target.value)}
                      placeholder="max"
                      min={0}
                      className="w-full min-w-0 px-2 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) tabular-nums"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-(--text-muted) w-16 shrink-0">Length</span>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <input
                      type="number"
                      value={durationMin}
                      onChange={(e) => setDurationMin(e.target.value)}
                      placeholder="min"
                      min={0}
                      className="w-full min-w-0 px-2 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) tabular-nums"
                    />
                    <span className="text-(--text-faint) text-xs">–</span>
                    <input
                      type="number"
                      value={durationMax}
                      onChange={(e) => setDurationMax(e.target.value)}
                      placeholder="max"
                      min={0}
                      className="w-full min-w-0 px-2 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) tabular-nums"
                    />
                    <select
                      value={durationUnit}
                      onChange={(e) => setDurationUnit(e.target.value as "sec" | "min")}
                      className="px-1 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) shrink-0"
                    >
                      <option value="sec">sec</option>
                      <option value="min">min</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-(--border)">
                <span className="text-xs text-(--text-faint)">
                  {filteredChapters.length} of {chapters.length} chapters match
                </span>
                <div className="flex-1" />
                <Button variant="secondary" size="sm" onClick={clearFilters} data-testid="chapter-filters-clear">
                  Clear all
                </Button>
                <Button variant="primary" size="sm" onClick={close}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </Menu>

        <div className="flex-1" />

        {isFiltered && (
          <span className="flex items-center gap-3 text-xs">
            <span className="text-(--text-muted)">
              Showing {filteredChapters.length} of {chapters.length}
            </span>
            <button
              onClick={() => onSetSelectedBatch(filteredChapters.map((c) => c.id), true)}
              className="text-(--accent-text) hover:text-(--accent-text-hover) font-medium"
            >
              Select filtered
            </button>
            <button
              onClick={() => onSetSelectedBatch(filteredChapters.map((c) => c.id), false)}
              className="text-(--text-muted) hover:text-(--text-secondary) font-medium"
            >
              Deselect
            </button>
          </span>
        )}
      </div>


      {/* The table is the scroller and thead sticks to it, so the filters above stay put. No
          overflow-x: the width contract drops columns instead of sliding them sideways. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain rounded-lg border border-(--border)">
        <table className="w-full divide-y divide-(--divide)">
          {/* The card colour under the tint: --bg-subtle is a 4% wash in dark mode, and rows scrolling
              under a translucent header read as a rendering fault */}
          <thead className="bg-(--bg-card) sticky top-0 z-10">
            <tr className="bg-(--bg-subtle)">
              {canDrag && <th className="w-8 px-2 py-3"></th>}
              <th className="px-3 py-3 w-10">
                <input
                  ref={toggleAllRef}
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={handleToggleAll}
                  className="rounded border-(--border-input) text-(--accent-text)"
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider">#</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider">Title</th>
              {isMultiFile && layout.showHeadMeta && (
                <th className="px-4 py-3 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider">Source</th>
              )}
              <th className="px-4 py-3 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider w-40">Status</th>
              {layout.showWords && (
                <th className="px-4 py-3 text-right text-xs font-medium text-(--text-muted) uppercase tracking-wider">Words</th>
              )}
              {layout.showDuration && (
                <th className="px-4 py-3 text-right text-xs font-medium text-(--text-muted) uppercase tracking-wider">Duration</th>
              )}
              <th className="px-4 py-3 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-(--bg-card) divide-y divide-(--divide)">
            {filteredChapters.map((chapter) => {
              const sourceFile =
                files?.find((f) => f.index === chapter.sourceFileIndex) ?? (files?.length === 1 ? files[0] : undefined);
              return (
                <tr
                  key={chapter.id}
                  data-testid="chapter-row"
                  draggable={!!canDrag}
                  onDragStart={(e) => {
                    if (!canDrag) return;
                    e.dataTransfer.effectAllowed = "move";
                    setDragChapterId(chapter.id);
                  }}
                  onDragOver={(e) => {
                    if (!canDrag || dragChapterId === chapter.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDragOverChapterId(chapter.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!canDrag || !dragChapterId || dragChapterId === chapter.id) return;
                    const fromIdx = chapters.findIndex((c) => c.id === dragChapterId);
                    const toIdx = chapters.findIndex((c) => c.id === chapter.id);
                    if (fromIdx === -1 || toIdx === -1) return;
                    const reordered = [...chapters];
                    const [moved] = reordered.splice(fromIdx, 1);
                    if (moved) {
                      reordered.splice(toIdx, 0, moved);
                      onReorder!(reordered.map((c) => c.id));
                    }
                    setDragChapterId(null);
                    setDragOverChapterId(null);
                  }}
                  onDragEnd={() => { setDragChapterId(null); setDragOverChapterId(null); }}
                  className={`group hover:bg-(--bg-card-hover) ${!chapter.selected ? "opacity-40" : ""} ${dragChapterId === chapter.id ? "opacity-30" : ""} ${dragOverChapterId === chapter.id && dragChapterId !== chapter.id ? "border-t-2 border-(--accent)" : ""}`}
                >
                  {canDrag && (
                    <td className="px-2 py-3 cursor-grab text-(--text-faint)">
                      <IconDragHandle className="h-4 w-4" />
                    </td>
                  )}
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={chapter.selected}
                      onChange={() => {}}
                      onClick={(e) => {
                        const filteredIdx = filteredChapters.indexOf(chapter);
                        const newValue = !chapter.selected;
                        if (e.shiftKey && lastClickedFilteredIndex.current !== null) {
                          const from = Math.min(lastClickedFilteredIndex.current, filteredIdx);
                          const to = Math.max(lastClickedFilteredIndex.current, filteredIdx);
                          const ids = filteredChapters.slice(from, to + 1).map((c) => c.id);
                          onSetSelectedBatch(ids, newValue);
                        } else {
                          onSetSelected(chapter.id, newValue);
                        }
                        lastClickedFilteredIndex.current = filteredIdx;
                      }}
                      className="rounded border-(--border-input) text-(--accent-text)"
                    />
                  </td>
                  <td className="px-4 py-3 text-sm text-(--text-tertiary)">{chapter.index + 1}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <EditableChapterTitle
                        title={chapter.title}
                        onRename={onRename ? (title) => onRename(chapter.id, title) : undefined}
                        onClickTitle={() => openChapterModal(chapters.indexOf(chapter))}
                      />
                      {!variant && chapter.cleanup?.status === "done" ? (
                        <span
                          className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-medium bg-(--success-bg) text-(--success-text)"
                          title="Cleaned by AI — the custom text holds the result"
                        >
                          cleaned
                        </span>
                      ) : chapter.hasCustomText ? (
                        <span className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-medium bg-(--warning-bg) text-(--warning-text)">
                          edited
                        </span>
                      ) : null}
                      {chapter.source?.kind === "book" ? (
                        <Link
                          to={`/books/${chapter.source.bookId}`}
                          className="text-xs text-(--accent-text) hover:text-(--accent-text-hover)"
                          title={`Open the source book: "${chapter.source.title}"`}
                          data-testid="chapter-source-link"
                        >
                          source <IconExternal className="h-3 w-3" />
                        </Link>
                      ) : chapter.source?.kind === "url" ? (
                        <a
                          href={chapter.source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-(--accent-text) hover:text-(--accent-text-hover)"
                          title={chapter.source.title ?? chapter.source.url}
                        >
                          source <IconExternal className="h-3 w-3" />
                        </a>
                      ) : null}
                      {chapter.pageStart && layout.showPages ? (
                        sourceFile ? (
                          <button
                            onClick={() =>
                              setPdfPreview({ fileId: sourceFile.id, page: chapter.pageStart!, filename: sourceFile.filename })
                            }
                            className="text-xs text-(--accent-text) hover:text-(--accent-text-hover) tabular-nums"
                            title="Open the source PDF at this chapter's first page"
                          >
                            p.{chapter.pageStart}{chapter.pageEnd && chapter.pageEnd !== chapter.pageStart ? `–${chapter.pageEnd}` : ""}
                          </button>
                        ) : (
                          <span className="text-xs text-(--text-faint) tabular-nums">
                            p.{chapter.pageStart}{chapter.pageEnd && chapter.pageEnd !== chapter.pageStart ? `–${chapter.pageEnd}` : ""}
                          </span>
                        )
                      ) : null}
                    </div>
                  </td>
                  {isMultiFile && layout.showHeadMeta && (
                    <td className="px-4 py-3 text-xs text-(--text-muted) truncate max-w-32" title={files!.find((f) => f.index === chapter.sourceFileIndex)?.filename}>
                      {files!.find((f) => f.index === chapter.sourceFileIndex)?.filename ?? "\u2014"}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <ChapterStatusCell chapter={chapter} cleanup={variant ? null : chapter.cleanup ?? null} />
                  </td>
                  {layout.showWords && (
                    <td className="px-4 py-3 text-sm text-(--text-tertiary) text-right tabular-nums">
                      {chapter.wordCount.toLocaleString()}
                    </td>
                  )}
                  {layout.showDuration && (
                    <td className="px-4 py-3 text-sm text-(--text-tertiary) text-right tabular-nums">
                      {chapter.durationMs ? formatDuration(chapter.durationMs) : "\u2014"}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="icon"
                        size="sm"
                        onClick={() => openChapterModal(chapters.indexOf(chapter))}
                        title="Open this chapter — text, audio, editing"
                        aria-label="Open chapter"
                        data-testid="chapter-open"
                      >
                        <IconExpand className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="icon"
                        size="sm"
                        onClick={() => handlePlay(chapter.id)}
                        disabled={!(chapter.status === "done" && chapter.audioPath)}
                        title={
                          chapter.status === "done" && chapter.audioPath
                            ? playingChapterId === chapter.id && isAudioPlaying
                              ? "Pause"
                              : "Play"
                            : "No audio yet"
                        }
                        aria-label={playingChapterId === chapter.id && isAudioPlaying ? "Pause" : "Play"}
                        data-testid="chapter-play"
                      >
                        {playingChapterId === chapter.id && isAudioPlaying ? (
                          <IconPause weight="fill" className="h-4 w-4" />
                        ) : (
                          <IconPlay className="h-4 w-4" />
                        )}
                      </Button>
                      {!variant ? (
                        <Button
                          variant="icon"
                          size="sm"
                          href={`/books/${bookId}/read?chapter=${chapter.index}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open the read-along reader in a new tab"
                          aria-label="Open the read-along reader"
                          data-testid="chapter-reader"
                        >
                          <IconBook className="h-4 w-4" />
                        </Button>
                      ) : null}
                      <Button
                        variant="icon"
                        size="sm"
                        onClick={() => setAiChapter({ id: chapter.id, title: chapter.title })}
                        title="Summarize, question, or run any prompt against this chapter's text"
                        aria-label="Ask AI about this chapter"
                        data-testid="row-ask-ai"
                      >
                        <IconAi className="h-4 w-4" />
                      </Button>
                      {chapter.status === "suspended" || chapter.status === "failed" ? (
                        <Button
                          variant="success"
                          soft
                          square
                          size="sm"
                          onClick={() => onQueue(chapter.id, true)}
                          title="Continue synthesis from where it stopped — reuses already-synthesized chunks"
                          aria-label="Continue synthesis"
                        >
                          <IconContinue className="h-4 w-4" />
                        </Button>
                      ) : null}
                      <Button
                        variant="icon"
                        size="sm"
                        onClick={() => setSynthesizeChapterId(chapter.id)}
                        disabled={SYNTH_BUSY.includes(chapter.status) || chapter.synthesizable === false}
                        title={
                          chapter.synthesizable === false
                            ? "No finished translation for this chapter"
                            : SYNTH_BUSY.includes(chapter.status)
                              ? "Can't re-synthesize while it's being processed"
                              : "Pick a voice and synthesize this chapter's audio again, replacing the current audio"
                        }
                        aria-label="Re-synthesize chapter audio"
                        data-testid="row-synthesize"
                      >
                        <IconRefresh className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="icon"
                        size="sm"
                        href={chapterAudioDownload(chapter, variant).href}
                        download={chapterAudioDownload(chapter, variant).filename}
                        disabled={!(chapter.status === "done" && chapter.audioPath)}
                        title={
                          chapter.status === "done" && chapter.audioPath
                            ? `Download the ${variant ? variantLabel(variant) : "chapter"} audio`
                            : `No ${variant ? variantLabel(variant) : "chapter"} audio to download yet`
                        }
                        aria-label="Download chapter audio"
                      >
                        <IconDownload className="h-4 w-4" />
                      </Button>
                      {chapter.error ? (
                        <span className="text-xs text-(--danger-text)" title={chapter.error}>
                          error
                        </span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredChapters.length === 0 && chapters.length > 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-(--text-faint)">
                  No chapters match the current filters
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {playingChapter ? (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-50 w-[min(72rem,calc(100vw-2rem))] bg-(--bg-card) border border-(--border) rounded-lg px-4 py-3 flex items-center gap-4 shadow-lg">
          <button
            onClick={() => handlePlay(playingChapter.id)}
            className="text-(--accent-text) hover:text-(--accent-text-hover) w-8 h-8 flex items-center justify-center shrink-0"
            title={isAudioPlaying ? "Pause" : "Play"}
            aria-label={isAudioPlaying ? "Pause" : "Play"}
          >
            {isAudioPlaying ? <IconPause weight="fill" className="h-5 w-5" /> : <IconPlay className="h-5 w-5" />}
          </button>
          <div className="text-sm text-(--text-secondary) font-medium truncate min-w-0 shrink-0 max-w-48">
            Ch {playingChapter.index + 1} &mdash; {playingChapter.title}
          </div>
          <audio
            ref={audioRef}
            src={chapterAudioUrl(playingChapter)}
            onPlay={() => setIsAudioPlaying(true)}
            onPause={() => setIsAudioPlaying(false)}
            onEnded={() => { setPlayingChapterId(null); setIsAudioPlaying(false); }}
            controls
            className="flex-1 h-8 min-w-0"
          />
          <button
            onClick={handleStopPlayer}
            className="text-xs text-(--text-faint) hover:text-(--text-tertiary) shrink-0"
            title="Close player"
            aria-label="Close player"
          >
            <IconClose className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      {pdfPreview ? (
        <PdfPreviewModal
          fileId={pdfPreview.fileId}
          page={pdfPreview.page}
          filename={pdfPreview.filename}
          onClose={() => setPdfPreview(null)}
        />
      ) : null}

      {modalChapterIndex !== null ? (
        <ChapterModal
          language={language}
          bookId={bookId}
          chapters={chapters}
          files={files}
          chapterIndex={modalChapterIndex}
          variant={variant}
          variants={variants}
          onSwitchVariant={onSwitchVariant}
          onClose={() => openChapterModal(null)}
          onNavigate={openChapterModal}
          onQueue={onQueue}
          onSetSelected={onSetSelected}
          onPickVoice={setSynthesizeChapterId}
          voicePickerOpen={synthesizeChapterId !== null}
        />
      ) : null}

      {aiChapter ? (
        <ChapterAiModal
          scope={{ kind: "chapters", bookId, chapters: [aiChapter] }}
          onClose={() => setAiChapter(null)}
        />
      ) : null}

      {synthesizeChapterId ? (
        <SynthesizeModal
          {...synth}
          count={1}
          language={variant ? variantLabel(variant) : null}
          bookLanguage={language}
          canStart={!SYNTH_BUSY.includes(chapters.find((c) => c.id === synthesizeChapterId)?.status ?? "")}
          disabledReason="This chapter is already being processed"
          onStart={() => {
            onQueue(synthesizeChapterId);
            setSynthesizeChapterId(null);
          }}
          onClose={() => setSynthesizeChapterId(null)}
        />
      ) : null}
    </div>
  );
}

function ChapterStatusCell({ chapter, cleanup }: { chapter: ChapterRow; cleanup: ChapterRow["cleanup"] }) {
  let main;
  if ((chapter.status === "synthesizing" || chapter.status === "translating") && chapter.progress) {
    const [current = 0, total = 0] = chapter.progress.split("/").map(Number);
    const percent = total > 0 ? (current / total) * 100 : 0;

    main = (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <StatusBadge status={chapter.status} />
          <span className="text-[10px] text-(--text-muted) tabular-nums">{chapter.progress}</span>
        </div>
        <div className="w-full bg-(--bg-page) rounded-full h-1">
          <div
            className="bg-(--accent) h-1 rounded-full transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    );
  } else if (chapter.status === "suspended" && chapter.progress) {
    main = (
      <div className="flex items-center gap-2">
        <StatusBadge status={chapter.status} error={chapter.error} />
        <span className="text-[10px] text-(--text-muted) tabular-nums">{chapter.progress}</span>
      </div>
    );
  } else {
    main = <StatusBadge status={chapter.status} error={chapter.error} />;
  }

  const cleaningActive = cleanup?.status === "cleaning" || cleanup?.status === "pending";
  if (!cleaningActive && cleanup?.status !== "failed") return main;

  const [current = 0, total = 0] = (cleanup?.progress ?? "").split("/").map(Number);
  const percent = total > 0 ? (current / total) * 100 : 0;
  return (
    <div className="space-y-1" data-testid="chapter-cleanup-status">
      {main}
      {cleaningActive ? (
        <>
          <div className="flex items-center gap-2">
            <StatusBadge status="cleaning" />
            {cleanup?.progress ? (
              <span className="text-[10px] text-(--text-muted) tabular-nums">{cleanup.progress}</span>
            ) : null}
          </div>
          <div className="w-full bg-(--bg-page) rounded-full h-1">
            <div
              className="bg-(--badge-normalizing-text) h-1 rounded-full transition-all duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
        </>
      ) : (
        <span className="text-[10px] text-(--danger-text)" title={cleanup?.error ?? undefined}>
          cleanup failed
        </span>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function EditableChapterTitle({
  title,
  onRename,
  onClickTitle,
}: {
  title: string;
  onRename?: (title: string) => void;
  onClickTitle?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  function save() {
    const trimmed = value.trim();
    if (trimmed && trimmed !== title && onRename) onRename(trimmed);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="text-sm font-medium text-(--text-primary) bg-transparent border-b border-(--accent) outline-none w-full"
      />
    );
  }

  return (
    <span className="flex items-center gap-1">
      {onClickTitle ? (
        <button
          onClick={onClickTitle}
          className="text-sm font-medium text-(--text-primary) hover:text-(--accent-text-hover) text-left"
        >
          {title}
        </button>
      ) : (
        <span className="text-sm font-medium text-(--text-primary) text-left">{title}</span>
      )}
      {onRename && (
        <button
          onClick={(e) => { e.stopPropagation(); setValue(title); setEditing(true); }}
          className="text-(--text-faint) hover:text-(--text-tertiary) opacity-0 group-hover:opacity-100 transition-opacity"
          title="Rename chapter"
          aria-label="Rename chapter"
        >
          <IconRename className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}
