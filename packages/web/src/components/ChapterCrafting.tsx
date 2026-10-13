import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { trpc } from "../trpc.ts";
import { Button } from "./Button.tsx";
import { Menu } from "./Menu.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { PdfPreviewModal } from "./PdfPreviewModal.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { useShellLayout } from "./book/BookShell.tsx";
import { PdfCanvas } from "./reader/PdfCanvas.tsx";
import { formatDuration } from "../lib/format.ts";
import {
  boundKey,
  countWords,
  draftBoundaries,
  initialDraft,
  outline as buildOutline,
  pageGroups,
  revealRun,
  runSlices,
  RUN_STEP_PAGES,
  type RunReveal,
  type Bound,
  type BoundSource,
  type CraftBlock,
  type CraftFile,
  type Draft,
  type DraftChapter,
  type EditDecision,
  type FrontMatter,
} from "../lib/chapter-craft.ts";
import type { ChapterProposal } from "../../../server/src/schema.ts";
import {
  IconAdd,
  IconAi,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconExternal,
  IconHide,
  IconMerge,
  IconMove,
  IconRedo,
  IconRename,
  IconSpeaker,
  IconUndo,
  IconWarning,
} from "./icons.tsx";

const HISTORY_LIMIT = 50;
// Gutter items beside a rendered page: a boundary card and a suggestion pill, and the gap kept between them
const CARD_HEIGHT = 62;
const PILL_HEIGHT = 20;
const GUTTER_GAP = 8;

// Where each block's gutter item sits, in px below its own rule: cuts on nearby lines would otherwise
// stack their cards on top of each other, so each is pushed below the one above
function gutterOffsets(blocks: CraftBlock[], pageHeight: number, heightOf: (b: CraftBlock) => number): number[] {
  let next = 0;
  return blocks.map((b) => {
    const height = heightOf(b);
    if (!b.box || height === 0) return 0;
    const y = (b.box[1] / 10_000) * pageHeight;
    const top = Math.max(y, next);
    next = top + height + GUTTER_GAP;
    return top - y;
  });
}
const UNTITLED = "Untitled chapter";

type View = "pages" | "text";

const CHIP: Record<DraftChapter["status"], { className: string; label: string; title: string }> = {
  kept: { className: "bg-(--success-bg) text-(--success-text)", label: "unchanged · audio kept", title: "Same source blocks as the saved chapter: its text, edits and audio carry over untouched." },
  new: { className: "bg-(--bg-subtle) text-(--text-muted)", label: "new · needs synthesis", title: "No saved chapter covered exactly these blocks. It is cut from the saved page extraction — no OCR runs — and waits for you to queue synthesis." },
  reset: { className: "bg-(--warning-bg) text-(--warning-text)", label: "re-cut · audio resets", title: "A saved chapter with audio, edits or variants is cut differently here, so that work no longer matches and is dropped when you apply." },
  conflict: { className: "bg-(--danger-bg) text-(--danger-text)", label: "needs a decision", title: "The saved chapter had an edited text override; decide below what happens to it." },
};

const COVERAGE: Record<DraftChapter["status"], string> = {
  kept: "bg-(--success-text)",
  new: "bg-(--text-faint)",
  reset: "bg-(--warning-text)",
  conflict: "bg-(--danger-text)",
};

const SOURCE_TITLE: Record<BoundSource, string> = {
  heading: "Suggested by a heading the extraction recognised",
  manual: "Placed by hand",
  ai: "Proposed by the AI model",
};

const pageRange = (a: number, b: number) => (a === b ? `p.${a}` : `p.${a}–${b}`);
const fmt = (n: number) => n.toLocaleString("en-US");

export function ChapterCrafting({
  bookId,
  isProcessing,
  chapterProposal,
  chapterModel,
  files: bookFiles,
  onClose,
  onChanged,
}: {
  bookId: string;
  isProcessing: boolean;
  chapterProposal: ChapterProposal | null;
  chapterModel: string | null;
  files?: { id: string; index: number; filename: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const layout = useShellLayout();
  const { data: structure, isLoading } = trpc.books.structure.useQuery({ id: bookId });
  const files: CraftFile[] = useMemo(() => structure?.files ?? [], [structure]);
  const base = useMemo(() => initialDraft(files), [files]);

  // The draft is the saved structure until the first edit; Discard just drops the edits
  const [edited, setEdited] = useState<Draft | null>(null);
  const [history, setHistory] = useState<Draft[]>([]);
  const [future, setFuture] = useState<Draft[]>([]);
  const [moving, setMoving] = useState<string | null>(null);
  const [view, setView] = useState<View>("pages");
  const [expanded, setExpanded] = useState<Record<string, RunReveal | undefined>>({});
  const [pdf, setPdf] = useState<{ fileIndex: number | null; page: number } | null>(null);
  const [pdfPreview, setPdfPreview] = useState<{ fileId: string; page: number; filename?: string } | null>(null);
  const [model, setModel] = useState<string>(chapterModel ?? "");
  const sourceRef = useRef<HTMLDivElement>(null);
  // The start just placed: its title field takes focus, so placing and naming a chapter is one motion
  const focusKey = useRef<string | null>(null);
  const draft = edited ?? base;

  const proposalBoundaries = useMemo(() => (chapterProposal?.status === "done" ? chapterProposal.boundaries ?? [] : []), [chapterProposal]);
  const aiSuggested = useMemo(
    () => new Map(proposalBoundaries.map((b) => [boundKey(b.fileIndex, b.blockIndex), b.title] as const)),
    [proposalBoundaries],
  );
  const outline = useMemo(() => buildOutline(files, draft), [files, draft]);
  const chapterByKey = useMemo(() => new Map(outline.chapters.map((c) => [c.key, c])), [outline]);

  const proposeMutation = trpc.books.proposeChapters.useMutation({ onSuccess: onChanged });
  const applyMutation = trpc.books.applyChapterBoundaries.useMutation({
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });
  const confirmMutation = trpc.books.confirmStructure.useMutation({
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });
  const proposalRunning = chapterProposal?.status === "running";
  const { data: runningLogs } = trpc.books.logs.useQuery({ bookId }, { enabled: proposalRunning, refetchInterval: 2000 });
  const proposalProgress = proposalRunning
    ? [...(runningLogs ?? [])]
        .reverse()
        .find((l) => l.message.startsWith("[AI]") && chapterProposal && new Date(l.createdAt) >= new Date(chapterProposal.createdAt))
        ?.message.replace(/^\[AI\]\s*/, "")
    : undefined;

  useEffect(() => {
    if (!focusKey.current) return;
    const input = document.querySelector<HTMLInputElement>(`#bnd-${CSS.escape(focusKey.current)} input`);
    input?.focus();
    input?.select();
    focusKey.current = null;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && moving) setMoving(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moving]);

  // A title edit is one undo step from the moment the field is focused, not one per keystroke
  function snapshot() {
    setHistory((h) => [...h, draft].slice(-HISTORY_LIMIT));
    setFuture([]);
  }

  function commit(next: Draft) {
    snapshot();
    setMoving(null);
    setEdited(next);
  }

  function setBound(key: string, bound: Bound | null): Draft {
    const bounds = { ...draft.bounds };
    if (bound) bounds[key] = bound;
    else delete bounds[key];
    return { ...draft, bounds };
  }

  function addAt(key: string, title: string, source: BoundSource) {
    if (moving) {
      const moved = draft.bounds[moving];
      if (!moved) return;
      const next = setBound(moving, null);
      next.bounds[key] = { ...moved, source: "manual" };
      commit(next);
      return;
    }
    commit(setBound(key, { title, source }));
    focusKey.current = key;
  }

  function rename(key: string, title: string) {
    const bound = draft.bounds[key];
    if (bound) setEdited(setBound(key, { ...bound, title }));
  }

  function undo() {
    const prev = history.at(-1);
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [draft, ...f]);
    setMoving(null);
    setEdited(prev);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setFuture((f) => f.slice(1));
    setHistory((h) => [...h, draft]);
    setMoving(null);
    setEdited(next);
  }

  function discard() {
    if (!outline.unchanged && !confirm("Drop the draft and go back to the saved chapters?")) return;
    onClose();
  }

  function useProposal() {
    const bounds: Draft["bounds"] = {};
    for (const b of proposalBoundaries) bounds[boundKey(b.fileIndex, b.blockIndex)] = { title: b.title, source: "ai" };
    commit({ ...draft, bounds });
  }

  function apply() {
    if (outline.unchanged) {
      confirmMutation.mutate({ id: bookId });
      return;
    }
    const resolutions: Record<string, "keep" | "drop"> = {};
    for (const d of outline.decisions) {
      if (d.resolution) resolutions[d.saved.id] = d.resolution;
    }
    applyMutation.mutate({ id: bookId, boundaries: draftBoundaries(draft), resolutions });
  }

  function decide(savedId: string, resolution: "keep" | "drop" | null) {
    const resolutions = { ...draft.resolutions };
    if (resolution) resolutions[savedId] = resolution;
    else delete resolutions[savedId];
    commit({ ...draft, resolutions });
  }

  function pdfFileFor(fileIndex: number | null) {
    return bookFiles?.find((f) => f.index === fileIndex) ?? (bookFiles?.length === 1 ? bookFiles[0] : undefined);
  }

  function focusPage(fileIndex: number | null, page: number) {
    setPdf({ fileIndex, page });
  }

  function scrollTo(key: string) {
    const el = document.getElementById(`bnd-${key}`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  const headingCount = files.reduce((n, f) => n + f.blocks.filter((b) => b.heading).length, 0);
  const titleLikeCount = files.reduce((n, f) => n + f.blocks.filter((b) => b.titleLike && !b.closingMark).length, 0);
  const suggestionText = [
    `${headingCount} heading${headingCount === 1 ? "" : "s"}`,
    `${titleLikeCount} title-like line${titleLikeCount === 1 ? "" : "s"}`,
    ...(aiSuggested.size > 0 ? [`${aiSuggested.size} AI proposed`] : []),
  ].join(" · ");

  const { counts } = outline;
  const blocked = counts.conflicts > 0;
  const summaryBits = [`${outline.chapters.length} chapter${outline.chapters.length === 1 ? "" : "s"}`];
  if (counts.keptAudio) summaryBits.push(`keeps audio for ${counts.keptAudio}`);
  if (counts.reset) summaryBits.push(`resets ${counts.reset}`);
  if (counts.fresh) summaryBits.push(`${counts.fresh} new`);
  if (outline.excludedWords) summaryBits.push(`${fmt(outline.excludedWords)} words excluded`);
  if (outline.unlocated.length) summaryBits.push(`${outline.unlocated.length} saved chapter${outline.unlocated.length === 1 ? "" : "s"} no longer in the extraction`);

  const busy = applyMutation.isPending || confirmMutation.isPending;
  const applyDisabled = blocked || isProcessing || busy || outline.chapters.length === 0 || isLoading;
  const applyTitle = blocked
    ? "Decide what happens to the edited text first"
    : isProcessing
      ? "Wait for processing to finish"
      : outline.chapters.length === 0
        ? "Start at least one chapter"
        : outline.unchanged
          ? "The chapters stay as they are — this only records that you looked at them."
          : `Cuts ${outline.chapters.length} chapters from the saved page extraction. No OCR, transcription or synthesis starts. ${counts.kept ? `${counts.kept} chapter${counts.kept === 1 ? " keeps its" : "s keep their"} audio and edits; ` : ""}${counts.reset ? `${counts.reset} lose${counts.reset === 1 ? "s" : ""} audio and wait for re-synthesis; ` : ""}${counts.fresh} new.`;

  const showPdfPane = view === "text" && !layout.trayCompact;
  const pdfFile = pdf ? pdfFileFor(pdf.fileIndex) : undefined;
  const pdfSrc = pdf ? (pdfFile ? `/pdf/${pdfFile.id}` : bookFiles?.length ? null : `/pdf/book/${bookId}`) : null;
  const pdfPages = pdf ? (files.find((f) => f.fileIndex === pdf.fileIndex)?.totalPages ?? 0) : 0;

  const movingBound = moving ? draft.bounds[moving] : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="chapter-crafting">
      <div className="flex-1 min-h-0 flex">
        <div className="w-[300px] shrink-0 flex flex-col border-r border-(--border) bg-(--bg-card)">
          <div className="flex items-center gap-2 h-10 px-3 shrink-0 border-b border-(--border)">
            <span className="text-[10.5px] font-bold tracking-[.07em] uppercase text-(--text-muted)">Resulting chapters</span>
            <span
              className={`px-1.5 rounded-full text-[10.5px] font-semibold whitespace-nowrap ${outline.unchanged ? "bg-(--bg-subtle) text-(--text-muted)" : "bg-(--accent-subtle) text-(--accent-text)"}`}
              data-testid="craft-draft-state"
            >
              {outline.unchanged ? "as saved" : "draft"}
            </span>
            <div className="flex-1" />
            <span
              className="text-[11px] text-(--text-faint) whitespace-nowrap cursor-help"
              title={files.flatMap((f) => f.saved.map((s) => `${s.index + 1}. ${s.title}${s.hasAudio ? " · audio" : ""}${s.hasCustomText ? " · edited" : ""}`)).join("\n") || "No saved chapters"}
            >
              saved: {files.reduce((n, f) => n + f.saved.length, 0)}
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {outline.front.map((front) => (
              <div
                key={`front-${front.fileIndex ?? "legacy"}`}
                role="button"
                tabIndex={0}
                onClick={() => {
                  focusPage(front.fileIndex, front.pageStart);
                  sourceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                }}
                title="These words come before the first chapter start. They are left out of the audiobook, and stay visible in the source so you can bring them back."
                className="flex gap-2.5 px-3 py-2 border-b border-(--border) hover:bg-(--bg-subtle) text-left"
              >
                <IconHide className="w-[18px] shrink-0 text-(--text-faint) mt-0.5" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-(--text-muted) truncate">Before the first chapter</span>
                  <span className="block text-[11.5px] text-(--text-faint) whitespace-nowrap">{pageRange(front.pageStart, front.pageEnd)} · {fmt(front.words)} words</span>
                  <span className="flex items-center gap-1.5 mt-1">
                    <span className="px-1.5 rounded-full text-[10.5px] font-semibold bg-(--bg-subtle) text-(--text-muted)">excluded</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        addAt(boundKey(front.fileIndex, 0), "Front matter", "manual");
                      }}
                      className="text-[11.5px] font-semibold text-(--accent-text) hover:text-(--accent-text-hover) whitespace-nowrap"
                      data-testid="craft-front-to-chapter"
                    >
                      Make it a chapter
                    </button>
                  </span>
                </span>
              </div>
            ))}
            {outline.chapters.map((c, i) => {
              const chip = CHIP[c.status];
              const prev = outline.chapters[i - 1];
              return (
                <div
                  key={c.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    focusPage(c.fileIndex, c.pageStart);
                    scrollTo(c.key);
                  }}
                  className="flex gap-2.5 px-3 py-2 border-b border-(--border) hover:bg-(--bg-subtle) text-left"
                  data-testid="craft-chapter"
                >
                  <span className="w-[18px] shrink-0 text-right text-[11px] tabular-nums text-(--accent-text) mt-0.5">{c.num}.</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-(--text-primary) truncate" title={c.title}>{c.title || UNTITLED}</div>
                    <div className="text-[11.5px] text-(--text-muted) whitespace-nowrap">{pageRange(c.pageStart, c.pageEnd)} · {fmt(c.words)} words</div>
                    <div className="flex items-center gap-1.5 mt-1 min-w-0">
                      <span className={`px-1.5 rounded-full text-[10.5px] font-semibold truncate ${chip.className}`} title={chip.title} data-testid={`craft-status-${c.status}`}>
                        {chip.label}
                      </span>
                      {c.exact?.hasAudio && c.exact.durationMs != null && (
                        <span className="flex items-center gap-1 text-[11px] text-(--text-faint) whitespace-nowrap shrink-0" title="Existing audio for this chapter">
                          <IconSpeaker className="w-3 h-3" />
                          {formatDuration(c.exact.durationMs)}
                        </span>
                      )}
                      {c.exact?.hasCustomText && (
                        <span className="flex items-center gap-1 text-[11px] text-(--text-faint) whitespace-nowrap shrink-0" title="This chapter has an edited text override">
                          <IconRename className="w-3 h-3" />
                          edited
                        </span>
                      )}
                      {c.exact && c.exact.variants > 0 && (
                        <span className="text-[11px] text-(--text-faint) whitespace-nowrap shrink-0" title="Translations and rewrites of this chapter, kept with it">
                          {c.exact.variants} variant{c.exact.variants === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                    {c.decisions.map((d) => (
                      <EditDecisionCard key={d.saved.id} decision={d} where={`The cut at ${pageRange(c.pageStart, c.pageStart)} can't split that edit automatically.`} onDecide={decide} />
                    ))}
                  </div>
                  <Button
                    variant="ghost"
                    square
                    size="sm"
                    aria-label="Merge into previous chapter"
                    disabled={!prev || prev.fileIndex !== c.fileIndex}
                    title={!prev || prev.fileIndex !== c.fileIndex ? "The first chapter has nothing above it to merge into" : `Remove this chapter start — its text joins “${prev.title}”`}
                    onClick={(e) => {
                      e.stopPropagation();
                      commit(setBound(c.key, null));
                    }}
                    data-testid="craft-merge"
                  >
                    <IconMerge className="w-3.5 h-3.5" />
                  </Button>
                </div>
              );
            })}
            {outline.decisions.filter((d) => !d.target).map((d) => (
              <div key={d.saved.id} className="px-3 py-2 border-b border-(--border)" data-testid="craft-stranded-edit">
                <EditDecisionCard decision={d} where="No chapter in this draft covers its text, so the edit cannot be kept anywhere." onDecide={decide} />
              </div>
            ))}
            {!isLoading && outline.chapters.length === 0 && outline.front.length === 0 && (
              <p className="p-3 text-sm text-(--text-muted)">{files.some((f) => f.missing) ? "The extraction output is missing — extract the source files again." : "No extracted text to cut into chapters."}</p>
            )}
          </div>
          <div className="shrink-0 px-3 pt-2.5 pb-3 border-t border-(--border)">
            <div className="flex h-1.5 rounded-full overflow-hidden bg-(--bg-subtle)" data-testid="craft-coverage">
              {outline.totalWords > 0 && outline.excludedWords > 0 && (
                <span title={`Excluded · ${fmt(outline.excludedWords)} words`} style={{ width: `${(outline.excludedWords / outline.totalWords) * 100}%` }} className="shrink-0" />
              )}
              {outline.chapters.map((c) => (
                <span
                  key={c.key}
                  title={`${c.num}. ${c.title} · ${fmt(c.words)} words`}
                  style={{ width: `${outline.totalWords > 0 ? (c.words / outline.totalWords) * 100 : 0}%` }}
                  className={`shrink-0 shadow-[inset_-1px_0_0_var(--bg-card)] ${COVERAGE[c.status]}`}
                />
              ))}
            </div>
            <div className="mt-1.5 text-[11.5px] text-(--text-muted) leading-snug text-pretty">
              {fmt(outline.totalWords)} words in the source · {fmt(outline.inChapters)} in {outline.chapters.length} chapter{outline.chapters.length === 1 ? "" : "s"}
              {outline.excludedWords ? ` · ${fmt(outline.excludedWords)} excluded, still in the source` : ""}. Every included passage lands in exactly one chapter.
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-2 h-10 px-4 shrink-0 border-b border-(--border) bg-(--bg-card)">
            <span className="text-[10.5px] font-bold tracking-[.07em] uppercase text-(--text-muted) whitespace-nowrap">Source</span>
            <span title="Pages shows the PDF itself with the cuts drawn across it. Text shows the extracted blocks in a reading column beside a page preview — the only view for a file without layout boxes.">
              <SegmentedControl
                size="sm"
                value={view}
                onChange={(id) => setView(id as View)}
                options={[
                  { id: "pages", label: "Pages" },
                  { id: "text", label: "Text" },
                ]}
                testId="craft-view"
              />
            </span>
            <span className="text-[11.5px] text-(--text-faint) truncate">
              {files.length === 1 && files[0] ? `${files[0].filename} · ${files[0].totalPages} pages · ` : ""}
              {view === "pages" ? "the book's own pages — click between lines to start a chapter, the orange rules are the cuts" : "hover between blocks to start a chapter"}
            </span>
            <div className="flex-1" />
            {movingBound ? (
              <span className="flex items-center gap-2 h-[26px] pl-2.5 pr-1.5 rounded-full bg-(--accent-subtle) text-(--accent-text) text-[11.5px] font-semibold whitespace-nowrap min-w-0" data-testid="craft-moving">
                <span className="truncate">Moving “{movingBound.title || UNTITLED}” — click where it should start</span>
                <Button size="sm" variant="ghost" onClick={() => setMoving(null)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11.5px] text-(--text-muted) whitespace-nowrap cursor-help" title="Headings the extraction recognised, lines that look like titles, and any AI proposal are starting points — every chapter start is yours to move.">
                {suggestionText}
              </span>
            )}
            {proposalBoundaries.length > 0 && (
              <Button size="sm" variant="primary" soft onClick={useProposal} title={`Replace the draft's starts with the ${proposalBoundaries.length} the model proposed${chapterProposal?.detection ? ` (${chapterProposal.detection})` : ""}`} data-testid="use-proposal">
                Use proposal ({proposalBoundaries.length})
              </Button>
            )}
            {chapterProposal?.status === "failed" && (
              <span className="text-[11.5px] text-(--danger-text) truncate" title={chapterProposal.error}>Proposal failed</span>
            )}
            <Menu
              testId="craft-propose"
              width="w-80"
              trigger={({ toggle }) => (
                <Button size="sm" onClick={toggle} disabled={proposalRunning || proposeMutation.isPending} title="Ask the AI model to find the table of contents and propose chapter starts. Optional — everything here works without it." data-testid="craft-propose-open">
                  <IconAi className="w-3.5 h-3.5" />
                  {proposalRunning ? (proposalProgress ?? "Proposing…") : "Propose with AI…"}
                </Button>
              )}
            >
              {(close) => (
                <div className="p-3 flex flex-col gap-2">
                  <p className="text-xs text-(--text-secondary) text-pretty">Finds the table of contents and matches it to the pages. The proposal lands here as starting points; nothing is applied until you say so.</p>
                  <ModelPicker value={model} onChange={setModel} testId="structure-chapter-model" />
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => { proposeMutation.mutate({ id: bookId, method: "deterministic" }); close(); }} title="Re-run the heading heuristics without a model call">
                      Heuristic
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => { proposeMutation.mutate({ id: bookId, method: "llm", model }); close(); }} title="Ask the selected model (takes a few minutes on big or multi-file books)">
                      Ask the model
                    </Button>
                  </div>
                  {proposeMutation.error && <span className="text-xs text-(--danger-text)">{proposeMutation.error.message}</span>}
                </div>
              )}
            </Menu>
          </div>

          {/* The Pages view is the page plus its annotation gutter, wider than a pane beside the
              assistant: it scrolls sideways rather than squeezing the page */}
          <div ref={sourceRef} className={`flex-1 min-h-0 overflow-auto relative ${view === "pages" ? "bg-(--bg-page)" : "bg-(--bg-card)"}`} data-testid="craft-source">
            {isLoading ? (
              <p className="p-4 text-sm text-(--text-muted)">Loading the extraction…</p>
            ) : (
              files.map((file) => (
                <SourceFile
                  key={file.fileIndex ?? "legacy"}
                  file={file}
                  named={files.length > 1}
                  draft={draft}
                  view={view}
                  moving={moving}
                  aiSuggested={aiSuggested}
                  chapterByKey={chapterByKey}
                  front={outline.front.find((f) => f.fileIndex === file.fileIndex) ?? null}
                  expanded={expanded}
                  onRevealRun={(key, how) => setExpanded((e) => ({ ...e, [key]: revealRun(e[key], how) }))}
                  onAdd={addAt}
                  onRemove={(key) => commit(setBound(key, null))}
                  onMove={(key) => setMoving(moving === key ? null : key)}
                  onRename={rename}
                  onSnapshot={snapshot}
                  onFocusPage={focusPage}
                />
              ))
            )}
          </div>
        </div>

        {showPdfPane && (
          <div className="w-[250px] shrink-0 flex flex-col border-l border-(--border) bg-(--bg-page)" data-testid="craft-pdf-pane">
            <div className="flex items-center gap-1.5 h-10 pl-3 pr-2.5 shrink-0 border-b border-(--border)">
              <span className="text-[10.5px] font-bold tracking-[.07em] uppercase text-(--text-muted) whitespace-nowrap">Source PDF</span>
              <div className="flex-1" />
              {pdf && (
                <>
                  <Button variant="ghost" square size="sm" aria-label="Previous page" onClick={() => setPdf({ ...pdf, page: Math.max(1, pdf.page - 1) })}>
                    <IconChevronLeft className="w-3.5 h-3.5" />
                  </Button>
                  <span className="text-[11.5px] text-(--text-secondary) tabular-nums whitespace-nowrap">p.{pdf.page}{pdfPages ? ` / ${pdfPages}` : ""}</span>
                  <Button variant="ghost" square size="sm" aria-label="Next page" onClick={() => setPdf({ ...pdf, page: pdfPages ? Math.min(pdfPages, pdf.page + 1) : pdf.page + 1 })}>
                    <IconChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </>
              )}
            </div>
            <div className="flex-1 min-h-0 p-3 flex flex-col gap-2.5">
              {pdf && pdfSrc ? (
                // Keyed by page so the browser's PDF viewer re-navigates — hash-only changes are ignored.
                <iframe key={`${pdfSrc}-${pdf.page}`} src={`${pdfSrc}#page=${pdf.page}&toolbar=0`} className="flex-1 min-h-0 w-full rounded border border-(--border) bg-(--paper)" title="Source PDF" />
              ) : (
                <div className="flex-1 min-h-0 grid place-items-center rounded border border-(--border) bg-(--bg-card) text-[11.5px] text-(--text-faint) text-center px-3 text-pretty">
                  {pdf ? "This file's PDF is not available." : "Click a page, a chapter start or an outline row to see that page of the scan."}
                </div>
              )}
              <div className="text-[11.5px] text-(--text-muted) leading-snug text-pretty">Follows the page, boundary or chapter you last clicked, so a cut can be checked against the scan before applying.</div>
              {pdf && pdfFile && (
                <button onClick={() => setPdfPreview({ fileId: pdfFile.id, page: pdf.page, filename: pdfFile.filename })} className="flex items-center gap-1 text-xs font-semibold text-(--accent-text) hover:text-(--accent-text-hover) whitespace-nowrap" title="Open the full PDF viewer at this page">
                  <IconExternal className="w-3 h-3" />
                  Open in viewer
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2.5 h-[52px] px-4 shrink-0 border-t border-(--border) bg-(--bg-card)" data-testid="craft-footer">
        <span className="text-xs text-(--text-secondary) truncate">{summaryBits.join(" · ")}</span>
        {blocked && (
          <span className="flex items-center gap-1 px-2 rounded-full text-[11px] font-semibold bg-(--danger-bg) text-(--danger-text) whitespace-nowrap shrink-0">
            <IconWarning className="w-3 h-3" />
            {counts.conflicts} edit{counts.conflicts === 1 ? "" : "s"} need{counts.conflicts === 1 ? "s" : ""} a decision
          </span>
        )}
        {(applyMutation.error || confirmMutation.error) && (
          <span className="text-xs text-(--danger-text) truncate" data-testid="craft-error">{(applyMutation.error ?? confirmMutation.error)?.message}</span>
        )}
        <div className="flex-1" />
        <Button size="sm" onClick={undo} disabled={history.length === 0} title="Undo the last change to the draft" data-testid="craft-undo">
          <IconUndo className="w-3.5 h-3.5" />
          Undo
        </Button>
        <Button variant="icon" size="sm" onClick={redo} disabled={future.length === 0} aria-label="Redo" title="Redo" data-testid="craft-redo">
          <IconRedo className="w-3.5 h-3.5" />
        </Button>
        <Button size="sm" onClick={discard} disabled={busy} title={outline.unchanged ? "Back to the chapter list" : "Drop the draft and go back to the saved chapters"} data-testid="craft-discard">
          {outline.unchanged ? "Close" : "Discard changes"}
        </Button>
        <Button size="sm" variant="primary" onClick={apply} disabled={applyDisabled} title={applyTitle} data-testid="apply-boundaries">
          {outline.unchanged ? "Keep these chapters" : `Apply ${outline.chapters.length} chapter${outline.chapters.length === 1 ? "" : "s"}`}
        </Button>
      </div>

      {pdfPreview && <PdfPreviewModal fileId={pdfPreview.fileId} page={pdfPreview.page} filename={pdfPreview.filename} onClose={() => setPdfPreview(null)} />}
    </div>
  );
}

type SourceFileProps = {
  file: CraftFile;
  /** Several files, so each shows its name. */
  named: boolean;
  draft: Draft;
  view: View;
  moving: string | null;
  aiSuggested: Map<string, string>;
  chapterByKey: Map<string, DraftChapter>;
  front: FrontMatter | null;
  expanded: Record<string, RunReveal | undefined>;
  onRevealRun: (key: string, how: "next" | "previous" | "all" | "none") => void;
  onAdd: (key: string, title: string, source: BoundSource) => void;
  onRemove: (key: string) => void;
  onMove: (key: string) => void;
  onRename: (key: string, title: string) => void;
  onSnapshot: () => void;
  onFocusPage: (fileIndex: number | null, page: number) => void;
};

function SourceFile(props: SourceFileProps) {
  const { file, named, draft, view, moving, aiSuggested, front, expanded, onRevealRun, onAdd, onFocusPage } = props;
  const groups = useMemo(() => pageGroups(file, draft, new Set(aiSuggested.keys())), [file, draft, aiSuggested]);
  const key = (i: number) => boundKey(file.fileIndex, i);
  const firstStart = front?.firstStart ?? 0;
  const excluded = (b: CraftBlock) => front !== null && b.i < firstStart;
  const pages = view === "pages";

  // What sits above a block: its chapter start, a suggestion to start one, or a gap to click
  const cutFor = (b: CraftBlock, topOfPage: boolean, page: number, onPage: boolean, offset = 0): ReactNode => {
    const k = key(b.i);
    if (draft.bounds[k]) return <BoundaryRow {...props} k={k} page={page} onPage={onPage} offset={offset} />;
    const ai = aiSuggested.get(k);
    const suggest = b.heading
      ? "Heading found — start a chapter here"
      : ai !== undefined
        ? "AI proposed — start a chapter here"
        : b.titleLike
          ? b.closingMark
            ? "Capitals ending the page — a closing mark, or a title?"
            : "Looks like a title — start a chapter here"
          : null;
    if (suggest) {
      const why = b.heading
        ? "Extraction recognised this block as a section heading. Click to start a chapter at it."
        : ai !== undefined
          ? `The AI model proposed “${ai}” here. Click to start a chapter at it.`
          : b.closingMark
            ? "A short line in capitals at the foot of a page, under other text: usually a closing mark like THE END, sometimes a title whose story starts overleaf. Click to start a chapter at it."
            : "A short line in capitals on its own, but extraction read it as a paragraph, so the heading picker never saw it. Click to start a chapter at it.";
      const title = ai ?? (b.heading || b.titleLike ? b.text : UNTITLED);
      const source: BoundSource = ai !== undefined ? "ai" : b.heading ? "heading" : "manual";
      const quiet = ai === undefined && !b.heading && b.closingMark;
      return <CutLine kind={quiet ? "quiet" : "suggest"} onPage={onPage} offset={offset} label={suggest} title={why} onClick={() => onAdd(k, title, source)} testId="craft-suggest" />;
    }
    // The page header carries the start-at-page button; a second, hidden target would only shadow it
    if (topOfPage) return null;
    return (
      <CutLine
        kind={moving ? "moving" : "gap"}
        onPage={onPage}
        label={topOfPage ? `Start a chapter at page ${page}` : "Start a chapter here"}
        title={topOfPage ? `Start a chapter at the top of page ${page}` : `Start a chapter before this paragraph (block ${b.i})`}
        onClick={() => onAdd(k, UNTITLED, "manual")}
        testId="craft-gap"
      />
    );
  };

  const runKey = (from: number) => `${file.fileIndex ?? "legacy"}:${from}`;
  const pageId = (page: number) => `pg-${file.fileIndex ?? "legacy"}-${page}`;
  const wordsOf = (blocks: CraftBlock[]) => blocks.reduce((n, b) => n + (b.included ? countWords(b.text) : 0), 0);
  const inkOf = (b: CraftBlock) => (!b.included ? "text-(--text-faint) italic" : excluded(b) ? "text-(--text-faint)" : "text-(--text-primary)");

  // One page, every block, with the cut above each. The Pages view draws the PDF page itself, as
  // the reader does, with each cut at its block's top; the Text view is a numbered reading column,
  // and so is a page whose layout left no boxes to place cuts by. A run opens into these pages.
  const renderPage = (page: number, blocks: CraftBlock[], firstOfFile: boolean) => {
    const first = blocks[0];
    if (!first) return null;
    const words = wordsOf(blocks);
    const firstKey = key(first.i);
    const firstHasCut = !!draft.bounds[firstKey] || first.heading || first.titleLike || aiSuggested.has(firstKey);
    const dim = front !== null && (blocks.at(-1)?.i ?? 0) < firstStart;
    const size = pages ? file.pages.find((p) => p.p === page) : undefined;
    // Always in reach, whatever the layout made of the page: a title page may be one stray letter
    const startHere = !firstHasCut && (
      <Button
        size="sm"
        variant="primary"
        soft
        onClick={(e) => {
          e.stopPropagation();
          onAdd(firstKey, UNTITLED, "manual");
        }}
        title={moving ? `Put the moving chapter start at the top of page ${page}` : `Start a chapter at the top of page ${page}`}
        className={moving ? "bg-(--accent-subtle)" : ""}
        data-testid="craft-page-start"
      >
        <IconAdd className="w-3 h-3" />
        {moving ? "Move it to this page" : "Start a chapter at this page"}
      </Button>
    );

    // Every block placed, or none: a page with a block the layout could not place would lose that
    // block's cut and controls on the picture, so it reads as a column instead
    if (size && blocks.every((b) => b.box)) {
      const offsets = gutterOffsets(blocks, (480 * size.h) / size.w, (b) => (draft.bounds[key(b.i)] ? CARD_HEIGHT : b.heading || b.titleLike || aiSuggested.has(key(b.i)) ? PILL_HEIGHT : 0));
      return (
        <div key={`page-${page}`} id={pageId(page)} className={firstOfFile ? "" : "mt-7"}>
          <div className="flex items-center gap-2 w-[480px] mb-2">
            <span className="text-[10.5px] font-bold tracking-[.07em] uppercase text-(--text-muted) whitespace-nowrap">Page {page}</span>
            <span className="text-[11px] text-(--text-faint) whitespace-nowrap">{blocks.length} blocks · {words} words</span>
            {dim && <span className="px-1.5 rounded-full text-[10.5px] font-semibold bg-(--bg-subtle) text-(--text-muted) whitespace-nowrap">left out of the audiobook</span>}
            <div className="flex-1" />
            {startHere}
          </div>
          {/* `group`: hovering the page shows every gap faintly, so the lines between paragraphs can be found */}
          <div onClick={() => onFocusPage(file.fileIndex, page)} className={`group w-[480px] shadow-lg ${dim ? "opacity-60" : ""}`} data-testid="craft-page">
            <PdfCanvas url={file.pdfUrl} pageNumber={page} crop={[0, 0, size.w, size.h]} pageSize={size}>
              {blocks.map((b, j) =>
                b.box ? (
                  // From the block's own left edge: two column headings sharing a top do not share a hit box
                  <div key={b.i} className="absolute right-0" style={{ top: `${b.box[1] / 100}%`, left: `${b.box[0] / 100}%` }}>
                    {cutFor(b, j === 0, page, true, offsets[j])}
                  </div>
                ) : null,
              )}
            </PdfCanvas>
          </div>
        </div>
      );
    }

    return (
      <div key={`page-${page}`} id={pageId(page)} className={pages ? "w-[480px]" : ""}>
        <div onClick={() => onFocusPage(file.fileIndex, page)} className={`flex items-center gap-2 mb-0.5 pt-2.5 border-t border-(--border) cursor-default ${firstOfFile ? "mt-2" : "mt-4"}`}>
          <span className="text-[10.5px] font-bold tracking-[.07em] uppercase text-(--text-muted) whitespace-nowrap">Page {page}</span>
          <span className="text-[11px] text-(--text-faint) whitespace-nowrap">{blocks.length} blocks · {words} words</span>
          <div className="flex-1" />
          {startHere}
        </div>
        {blocks.map((b, j) => (
          <div key={b.i}>
            {cutFor(b, j === 0, page, false)}
            <div className="flex gap-2.5 py-0.5">
              <span className="shrink-0 w-9 pt-1 text-right text-[10px] tabular-nums text-(--text-faint) whitespace-nowrap" title={`Extracted block ${b.i}${!b.included ? ` · ${b.type}, not read aloud` : ""}`}>
                b.{b.i}
              </span>
              <p className={`flex-1 min-w-0 max-w-prose m-0 font-reading text-[17px] leading-relaxed text-pretty ${b.heading || b.titleLike ? "font-semibold" : ""} ${inkOf(b)}`}>{b.text}</p>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className={pages ? "pt-3 pb-20 pl-7 w-[850px]" : "max-w-[720px] px-4 pb-16 pt-1.5"}>
      {(named || file.missing) && (
        <h3 className="mt-3 mb-1 text-xs font-medium text-(--text-muted) uppercase tracking-wider truncate" title={file.filename}>
          {file.filename}
          {file.missing ? " — extraction output missing" : ""}
        </h3>
      )}
      {front && (
        <div className={`flex items-center gap-2 mt-2.5 mb-2 px-2.5 py-1.5 rounded-lg border border-dashed border-(--border-input) bg-(--bg-subtle) text-xs text-(--text-muted) ${pages ? "w-[480px] box-border" : ""}`} data-testid="craft-front-banner">
          <IconHide className="w-3.5 h-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            <b className="text-(--text-secondary)">Before the first chapter</b> · {pageRange(front.pageStart, front.pageEnd)} · {fmt(front.words)} words · left out of the audiobook
          </span>
          <div className="flex-1" />
          <button onClick={() => onAdd(key(0), "Front matter", "manual")} className="text-xs font-semibold text-(--accent-text) hover:text-(--accent-text-hover) whitespace-nowrap shrink-0">
            Make it a chapter
          </button>
        </div>
      )}
      {groups.map((g, gi) => {
        if (g.kind === "page") return renderPage(g.page, g.blocks, gi === 0);
        const k = runKey(g.from);
        const { head, hidden, tail } = runSlices(g.pages, expanded[k]);
        const opened = head.length + tail.length > 0;
        const meta = `${g.pages.length} pages · ${fmt(g.words)} words · no headings found`;
        const foldClass = `flex items-center gap-2.5 mt-3 px-3 py-1.5 rounded-lg border border-dashed border-(--border-input) bg-(--bg-subtle) text-(--text-muted) text-xs ${pages ? "w-[480px] box-border" : ""}`;
        const reveal = (how: "next" | "previous" | "all" | "none", label: string, title: string) => (
          <button onClick={() => onRevealRun(k, how)} title={title} className="text-xs font-semibold text-(--accent-text) hover:text-(--accent-text-hover) whitespace-nowrap shrink-0">
            {label}
          </button>
        );
        const first = hidden[0];
        const last = hidden.at(-1);
        return (
          <div key={`run-${g.from}`}>
            {opened && hidden.length === 0 && (
              <div className={foldClass}>
                <IconChevronDown className="w-3 h-3 shrink-0" />
                <span className="truncate"><b className="text-(--text-secondary)">Pages {g.from}–{g.to}</b> · {meta}</span>
                <div className="flex-1" />
                {reveal("none", "Hide", "Fold these pages away again")}
              </div>
            )}
            {head.map((p) => renderPage(p.page, p.blocks, false))}
            {first && last && (
              // Like a diff's folded stretch: open the next pages after what is shown above, the
              // last pages before what is shown below, or the whole run
              <div
                className={`${foldClass} ${opened ? "" : "py-2"}`}
                title="Pages with no recognised headings. Open them to place a chapter start on any paragraph."
                data-testid="craft-run"
              >
                <IconChevronRight className="w-3 h-3 shrink-0" />
                <span className="truncate">
                  <b className="text-(--text-secondary)">Pages {first.page}–{last.page}</b> · {opened ? `${hidden.length} pages · ${fmt(wordsOf(hidden.flatMap((p) => p.blocks)))} words` : meta}
                </span>
                <div className="flex-1" />
                {hidden.length > RUN_STEP_PAGES && reveal("next", `Next ${RUN_STEP_PAGES}`, `Show the ${RUN_STEP_PAGES} pages after the page above`)}
                {hidden.length > RUN_STEP_PAGES && reveal("previous", `Last ${RUN_STEP_PAGES}`, `Show the ${RUN_STEP_PAGES} pages before the page below`)}
                {reveal("all", opened ? `All ${hidden.length}` : "Show pages", "Show every page of this stretch")}
                {opened && reveal("none", "Hide", "Fold these pages away again")}
              </div>
            )}
            {tail.map((p) => renderPage(p.page, p.blocks, false))}
          </div>
        );
      })}
    </div>
  );
}

// One broken edit: where "keep" would put it, and the two ways out
function EditDecisionCard({ decision, where, onDecide }: { decision: EditDecision; where: string; onDecide: (savedId: string, resolution: "keep" | "drop" | null) => void }) {
  const { saved, target, resolution, collision } = decision;
  if (resolution && !collision) {
    return (
      <div className="flex items-center gap-1.5 mt-1.5 text-[11.5px] text-(--text-muted) whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
        <IconCheck className="w-3 h-3 text-(--success-text)" />
        <span className="truncate">
          {resolution === "keep" ? `“${saved.title}”: edit kept on this part — trim it after applying` : `“${saved.title}”: edit discarded — extracted text is used`}
        </span>
        <button onClick={() => onDecide(saved.id, null)} className="font-semibold text-(--accent-text) hover:text-(--accent-text-hover)">
          Change
        </button>
      </div>
    );
  }
  return (
    <div onClick={(e) => e.stopPropagation()} className="mt-2 p-2 rounded-md bg-(--danger-bg) text-[11.5px] text-(--text-secondary) cursor-default" data-testid="craft-conflict">
      <div className="flex items-center gap-1.5 text-(--danger-text) font-semibold whitespace-nowrap">
        <IconWarning className="w-3.5 h-3.5" />
        {collision ? "Only one edited text can be kept here" : "Edited text can't follow this cut"}
      </div>
      <div className="mt-0.5 leading-snug text-pretty">
        “{saved.title}” had an edited text override covering the whole chapter. {collision ? "Another kept edit already lands on this chapter." : where}
      </div>
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        {target && !collision && (
          <Button size="sm" onClick={() => onDecide(saved.id, "keep")} title="This part keeps the whole edited text; trim it in the chapter editor afterwards" data-testid="craft-keep-edit">
            Keep on this part
          </Button>
        )}
        <Button size="sm" variant="danger" soft onClick={() => onDecide(saved.id, "drop")} title="Back to the extracted text" data-testid="craft-drop-edit">
          Discard edit
        </Button>
      </div>
    </div>
  );
}

// The line a click draws across the text: a gap waiting for a start, a suggestion, or the place a
// moving start may land. On a rendered page it sits at the block's top, runs across the page and
// out into the gutter, where its label stays clear of the print.
// "quiet" is a suggestion the heuristics half-believe: visible in the muted tone, never orange
function CutLine({ kind, onPage, offset = 0, label, title, onClick, testId }: { kind: "gap" | "suggest" | "quiet" | "moving"; onPage: boolean; offset?: number; label: string; title: string; onClick: () => void; testId: string }) {
  const tone =
    kind === "suggest" || kind === "moving"
      ? "text-(--accent-text)"
      : kind === "quiet"
        ? "text-(--text-faint) hover:text-(--accent-text)"
        : `text-transparent hover:text-(--accent-text) ${onPage ? "group-hover:text-(--text-faint) group-hover:hover:text-(--accent-text)" : ""}`;
  const rule = kind === "suggest" ? "border-dashed border-(--accent)" : kind === "moving" || kind === "quiet" ? "border-dashed border-current" : "border-solid border-current";
  // The idle pill hides in the ground it sits on: the page's margin in the Pages view, the card in the Text view
  const pill = kind === "suggest" ? "bg-(--accent-subtle)" : `border border-current ${onPage ? "bg-(--bg-page)" : "bg-(--bg-card)"}`;
  if (onPage) {
    return (
      <div className="relative h-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title={title}
          className={`absolute left-0 -right-[342px] -top-2 h-4 flex items-center z-[1] hover:z-[5] ${tone}`}
          data-testid={testId}
        >
          <span className={`flex-1 h-0 border-t ${rule}`} />
          <span className={`shrink-0 mx-3 flex items-center gap-1 h-5 px-2 rounded-full text-[10.5px] font-bold whitespace-nowrap ${pill}`} style={offset ? { transform: `translateY(${offset}px)` } : undefined}>
            <IconAdd className="w-2.5 h-2.5" />
            {label}
          </span>
        </button>
      </div>
    );
  }
  return (
    <button onClick={onClick} title={title} className={`flex items-center gap-2 w-full my-0.5 ${kind === "gap" ? "h-3.5" : "mt-2 mb-0.5"} ${tone}`} data-testid={testId}>
      <span className={`flex-1 h-0 border-t ${rule}`} />
      <span className={`flex items-center gap-1 h-5 px-2 rounded-full text-[10.5px] font-bold whitespace-nowrap ${pill}`}>
        <IconAdd className="w-2.5 h-2.5" />
        {label}
      </span>
      <span className={`flex-1 h-0 border-t ${rule}`} />
    </button>
  );
}

function BoundaryRow({ k, page, onPage, offset = 0, file, draft, moving, chapterByKey, onRemove, onMove, onRename, onSnapshot, onFocusPage }: SourceFileProps & { k: string; page: number; onPage: boolean; offset?: number }) {
  // One undo step per visit to the title field, taken at the first keystroke: focus alone — which
  // every newly placed start receives — must not cost an Undo
  const armed = useRef(false);
  const bound = draft.bounds[k];
  const chapter = chapterByKey.get(k);
  if (!bound || !chapter) return null;
  const isMoving = moving === k;
  // Nothing above it in its own file: removing this start makes its text front matter, not part of a chapter
  const first = ![...chapterByKey.values()].some((c) => c.fileIndex === chapter.fileIndex && c.start < chapter.start);
  const removeLabel = first ? "Exclude" : "Merge up";
  const removeTitle = first ? "Remove this start — the text becomes material before the first chapter, left out of the audiobook" : "Remove this start — the text joins the chapter above";
  const controls = (
    <>
      <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onMove(k); }} title={isMoving ? "Stop moving" : "Move this chapter start: click any gap, page or heading to put it there. The title comes along."} className={isMoving ? "bg-(--accent-subtle) text-(--accent-text)" : ""} data-testid="craft-move">
        <IconMove className="w-3.5 h-3.5" />
        {isMoving ? "Cancel" : "Move"}
      </Button>
      <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onRemove(k); }} title={removeTitle} data-testid="craft-remove">
        {removeLabel === "Exclude" ? <IconHide className="w-3.5 h-3.5" /> : <IconMerge className="w-3.5 h-3.5" />}
        {removeLabel}
      </Button>
    </>
  );
  const input = (
    <input
      value={bound.title}
      onChange={(e) => {
        if (armed.current) {
          onSnapshot();
          armed.current = false;
        }
        onRename(k, e.target.value);
      }}
      onFocus={() => {
        armed.current = true;
      }}
      onBlur={() => {
        armed.current = false;
      }}
      onClick={(e) => e.stopPropagation()}
      placeholder={UNTITLED}
      title="Chapter title — edit freely"
      className={`h-7 px-2 rounded-md border border-(--border-input) bg-(--bg-input) text-(--text-primary) font-display font-semibold text-[14px] tracking-[-.01em] ${onPage ? "w-full box-border" : "flex-[0_1_360px] min-w-[220px]"}`}
      data-testid="craft-title"
    />
  );
  const chip = <span className="h-[22px] flex items-center px-2 rounded-full text-[11px] font-bold bg-(--accent) text-(--on-accent) whitespace-nowrap shrink-0">Chapter {chapter.num}</span>;
  const source = (
    <span className="px-1.5 rounded-full text-[10.5px] font-semibold bg-(--bg-subtle) text-(--text-muted) whitespace-nowrap shrink-0" title={SOURCE_TITLE[bound.source]}>
      {bound.source}
    </span>
  );

  if (onPage) {
    return (
      <div id={`bnd-${k}`} className="relative h-0 z-[2]" data-testid="craft-boundary">
        <span className={`absolute left-0 -right-[342px] -top-px h-0.5 ${isMoving ? "bg-(--border-input)" : "bg-(--accent)"}`} />
        {/* Pushed down past the card above it, with a lead back up to its own rule */}
        {offset > 0 && <span className="absolute left-[calc(100%+60px)] top-0 w-0.5 bg-(--accent)" style={{ height: offset + 4 }} />}
        <div onClick={(e) => { e.stopPropagation(); onFocusPage(file.fileIndex, page); }} className="absolute left-[calc(100%+70px)] w-[272px] flex flex-col gap-1.5" style={{ top: 4 + offset }}>
          <div className="flex items-center gap-1.5">
            {chip}
            {source}
            <div className="flex-1" />
            {controls}
          </div>
          {input}
        </div>
      </div>
    );
  }
  return (
    <div
      id={`bnd-${k}`}
      onClick={() => onFocusPage(file.fileIndex, page)}
      className="flex items-center gap-2 my-3 cursor-default bg-[linear-gradient(var(--accent)_0_0)] bg-[length:100%_2px] bg-center bg-no-repeat"
      style={isMoving ? { backgroundImage: "linear-gradient(var(--border-input) 0 0)" } : undefined}
      data-testid="craft-boundary"
    >
      <span className="shrink-0 flex items-center pr-1.5 bg-(--bg-card)">{chip}</span>
      {input}
      <span className="shrink-0 px-1.5 bg-(--bg-card)">{source}</span>
      <div className="flex-1" />
      <span className="shrink-0 flex gap-0.5 pl-1.5 bg-(--bg-card)">{controls}</span>
    </div>
  );
}
