import { useState, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { StatusBadge } from "./StatusBadge.tsx";
import { ChapterModal, chapterAudioDownload } from "./ChapterModal.tsx";
import { ChapterAiModal } from "./ChapterAiModal.tsx";
import { PdfPreviewModal } from "./PdfPreviewModal.tsx";
import { IconChevronRight, IconClose, IconDragHandle, IconExternal, IconRename } from "./icons.tsx";

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

const ACTION_PILL = "text-xs px-2 py-0.5 rounded-full border border-(--border) text-(--text-secondary) font-medium hover:bg-(--bg-subtle) whitespace-nowrap";

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
  synthVoice,
  onChangeSynthVoice,
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
  // Voice the next synthesis will use for this view (variant lane or book)
  synthVoice?: string;
  onChangeSynthVoice?: (voice: string) => void;
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
    if (!searchParams.has("chapter")) return;
    searchParams.delete("chapter");
    setSearchParams(searchParams, { replace: true });
  };

  const [aiChapter, setAiChapter] = useState<{ id: string; title: string } | null>(null);
  const [pdfPreview, setPdfPreview] = useState<{ fileId: string; page: number; filename?: string } | null>(null);
  const toggleAllRef = useRef<HTMLInputElement>(null);
  const lastClickedFilteredIndex = useRef<number | null>(null);
  const [playingChapterId, setPlayingChapterId] = useState<string | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Filter state
  const [filtersOpen, setFiltersOpen] = useState(false);
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

  // Derived: filtered chapters (no useMemo — simple filter, React Compiler handles it)
  const filteredChapters = chapters.filter((ch) => {
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
  const activeFilterCount = [search, statusFilter, wordCountMin, wordCountMax, durationMin, durationMax, sourceFileFilter].filter(Boolean).length;

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
    <>
      {/* Filter toggle + panel */}
      <div className="mb-3">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setFiltersOpen((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium text-(--text-tertiary) hover:text-(--text-primary)"
          >
            <IconChevronRight className={`h-3 w-3 transition-transform ${filtersOpen ? "rotate-90" : ""}`} />
            Filter
            {activeFilterCount > 0 && !filtersOpen ? (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-(--accent-subtle) text-(--accent-text)">
                {activeFilterCount}
              </span>
            ) : null}
          </button>
          {activeFilterCount > 0 ? (
            <button
              onClick={clearFilters}
              className="text-xs text-(--text-faint) hover:text-(--text-tertiary)"
            >
              Clear
            </button>
          ) : null}
        </div>

        {filtersOpen ? (
          <div className="bg-(--bg-card) border border-(--border) rounded-lg p-4 mb-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <label className="flex items-center gap-3">
                <span className="text-xs font-medium text-(--text-muted) w-16 shrink-0">Search</span>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by title..."
                  className="w-full px-2.5 py-1.5 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)"
                />
              </label>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-(--text-muted) w-16 shrink-0">Status</span>
                <div className="flex items-center gap-2 flex-1">
                  <select
                    value={statusOperator}
                    onChange={(e) => setStatusOperator(e.target.value as "is" | "is_not")}
                    className="px-2.5 py-1.5 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)"
                  >
                    <option value="is">is</option>
                    <option value="is_not">is not</option>
                  </select>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="flex-1 px-2.5 py-1.5 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)"
                  >
                    <option value="">All</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-(--text-muted) w-16 shrink-0">Words</span>
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="number"
                    value={wordCountMin}
                    onChange={(e) => setWordCountMin(e.target.value)}
                    placeholder="min"
                    min={0}
                    className="w-full px-2.5 py-1.5 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) tabular-nums"
                  />
                  <span className="text-(--text-faint) text-xs">–</span>
                  <input
                    type="number"
                    value={wordCountMax}
                    onChange={(e) => setWordCountMax(e.target.value)}
                    placeholder="max"
                    min={0}
                    className="w-full px-2.5 py-1.5 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) tabular-nums"
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-(--text-muted) w-16 shrink-0">Duration</span>
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="number"
                    value={durationMin}
                    onChange={(e) => setDurationMin(e.target.value)}
                    placeholder="min"
                    min={0}
                    className="w-full px-2.5 py-1.5 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) tabular-nums"
                  />
                  <span className="text-(--text-faint) text-xs">–</span>
                  <input
                    type="number"
                    value={durationMax}
                    onChange={(e) => setDurationMax(e.target.value)}
                    placeholder="max"
                    min={0}
                    className="w-full px-2.5 py-1.5 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) tabular-nums"
                  />
                  <select
                    value={durationUnit}
                    onChange={(e) => setDurationUnit(e.target.value as "sec" | "min")}
                    className="px-1.5 py-1.5 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) shrink-0"
                  >
                    <option value="sec">sec</option>
                    <option value="min">min</option>
                  </select>
                </div>
              </div>
              {isMultiFile && (
                <label className="flex items-center gap-3">
                  <span className="text-xs font-medium text-(--text-muted) w-16 shrink-0">Source</span>
                  <select
                    value={sourceFileFilter}
                    onChange={(e) => setSourceFileFilter(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)"
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
            </div>
          </div>
        ) : null}

        {/* Filter summary + bulk actions */}
        {isFiltered ? (
          <div className="flex items-center justify-between text-xs text-(--text-muted) mb-2">
            <span>
              Showing {filteredChapters.length} of {chapters.length} chapters
            </span>
            <div className="flex items-center gap-3">
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
                Deselect filtered
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Table — capped height so long books don't push the output controls off-screen */}
      <div className="overflow-x-auto overflow-y-auto max-h-[70vh] rounded-lg border border-(--border)">
        <table className="w-full min-w-[56rem] divide-y divide-(--divide)">
          <thead className="bg-(--bg-subtle) sticky top-0 z-10">
            <tr>
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
              {isMultiFile && (
                <th className="px-4 py-3 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider">Source</th>
              )}
              <th className="px-4 py-3 text-left text-xs font-medium text-(--text-muted) uppercase tracking-wider w-40">Status</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-(--text-muted) uppercase tracking-wider">Words</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-(--text-muted) uppercase tracking-wider">Duration</th>
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
                      {chapter.pageStart ? (
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
                  {isMultiFile && (
                    <td className="px-4 py-3 text-xs text-(--text-muted) truncate max-w-32" title={files!.find((f) => f.index === chapter.sourceFileIndex)?.filename}>
                      {files!.find((f) => f.index === chapter.sourceFileIndex)?.filename ?? "\u2014"}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <ChapterStatusCell chapter={chapter} cleanup={variant ? null : chapter.cleanup ?? null} />
                  </td>
                  <td className="px-4 py-3 text-sm text-(--text-tertiary) text-right tabular-nums">
                    {chapter.wordCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-(--text-tertiary) text-right tabular-nums">
                    {chapter.durationMs ? formatDuration(chapter.durationMs) : "\u2014"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {chapter.status === "done" && chapter.audioPath ? (
                        <button
                          onClick={() => handlePlay(chapter.id)}
                          className={`w-6 h-6 flex items-center justify-center rounded text-sm ${ playingChapterId === chapter.id ? "text-(--accent-text) hover:text-(--accent-text-hover)" : "text-(--text-faint) hover:text-(--text-secondary)" }`}
                          title={playingChapterId === chapter.id && isAudioPlaying ? "Pause" : "Play"}
                          data-testid="chapter-play"
                        >
                          {playingChapterId === chapter.id && isAudioPlaying ? "\u23F8" : "\u25B6"}
                        </button>
                      ) : null}
                      <button
                        onClick={() => openChapterModal(chapters.indexOf(chapter))}
                        title="Open this chapter — text, audio, editing"
                        className={ACTION_PILL}
                        data-testid="chapter-open"
                      >
                        Open
                      </button>
                      {chapter.hasSourceBlocks ? (
                        <a
                          href={`/read/chapter/${chapter.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={ACTION_PILL}
                          title="Open reader view in a new tab"
                        >
                          Read
                        </a>
                      ) : null}
                      <button
                        onClick={() => setAiChapter({ id: chapter.id, title: chapter.title })}
                        title="Summarize, question, or run any prompt against this chapter's text"
                        className={ACTION_PILL}
                        data-testid="row-ask-ai"
                      >
                        Ask AI
                      </button>
                      {chapter.status === "suspended" || chapter.status === "failed" ? (
                        <button
                          onClick={() => onQueue(chapter.id, true)}
                          title="Continue synthesis from where it stopped — reuses already-synthesized chunks"
                          className="text-xs px-2 py-0.5 rounded-full border border-(--success) text-(--success-text) font-medium hover:bg-(--success-bg)"
                        >
                          Continue
                        </button>
                      ) : null}
                      <button
                        onClick={() => onQueue(chapter.id)}
                        disabled={["pending", "normalizing", "synthesizing"].includes(chapter.status) || chapter.synthesizable === false}
                        title={
                          chapter.synthesizable === false
                            ? "No finished translation for this chapter"
                            : ["pending", "normalizing", "synthesizing"].includes(chapter.status)
                              ? "Can't re-synthesize while it's being processed"
                              : "Synthesize this chapter's audio again from scratch, replacing the current audio"
                        }
                        className={`${ACTION_PILL} disabled:opacity-30 disabled:cursor-not-allowed`}
                      >
                        Re-synthesize
                      </button>
                      {chapter.status === "done" && chapter.audioPath ? (
                        <a
                          href={chapterAudioDownload(chapter, variant).href}
                          download={chapterAudioDownload(chapter, variant).filename}
                          title={`Download the ${variant ? variant.label ?? variant.key : "chapter"} audio`}
                          className={`${ACTION_PILL} no-underline`}
                        >
                          Download
                        </a>
                      ) : (
                        <button
                          disabled
                          title={`No ${variant ? variant.label ?? variant.key : "chapter"} audio to download yet`}
                          className={`${ACTION_PILL} opacity-30 cursor-not-allowed hover:bg-transparent`}
                        >
                          Download
                        </button>
                      )}
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
            className="text-lg text-(--accent-text) hover:text-(--accent-text-hover) w-8 h-8 flex items-center justify-center shrink-0"
          >
            {isAudioPlaying ? "\u23F8" : "\u25B6"}
          </button>
          <div className="text-sm text-(--text-secondary) font-medium truncate min-w-0 shrink-0 max-w-48">
            Ch {playingChapter.index + 1} &mdash; {playingChapter.title}
          </div>
          <audio
            ref={audioRef}
            src={playingChapter.audioUrl ?? `/audio/chapter/${playingChapterId}`}
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
          synthVoice={synthVoice}
          onChangeSynthVoice={onChangeSynthVoice}
        />
      ) : null}

      {aiChapter ? (
        <ChapterAiModal
          scope={{ kind: "chapters", bookId, chapters: [aiChapter] }}
          onClose={() => setAiChapter(null)}
        />
      ) : null}
    </>
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
            className="bg-(--step-work) h-1 rounded-full transition-all duration-500"
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
