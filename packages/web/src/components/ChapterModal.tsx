import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { Link } from "react-router";
import { trpc } from "../trpc.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { PdfPreviewModal } from "./PdfPreviewModal.tsx";
import { ChapterAiModal } from "./ChapterAiModal.tsx";
import { VariantModal } from "./VariantModal.tsx";
import { VoicePickerChip } from "./VoicePicker.tsx";
import { PillToggle } from "./PillToggle.tsx";
import { TOOLBAR_BUTTON } from "../lib/button-classes.ts";
import { getVoiceLabel } from "../lib/voices.ts";
import { useBodyScrollLock } from "../lib/use-body-scroll-lock.ts";
import { CueTranscript } from "./reader/CueTranscript.tsx";
import { CuePages } from "./reader/CuePages.tsx";
import { fetchCues, fetchManifest, UNMAPPED, type ReaderCues, type ReaderManifest } from "../lib/reader-doc.ts";
import { useFollowCue, type FollowBand } from "../lib/cue-follow.ts";
import { useAudioTime } from "../lib/use-audio-time.ts";
import { usePlayPauseKey } from "../lib/play-pause-key.ts";
import { SPEEDS, loadSpeed, saveSpeed } from "../lib/playback-speed.ts";
import type { ChapterRow, FileInfo, VariantRef } from "./ChapterTable.tsx";

type ChapterModalProps = {
  bookId: string;
  chapters: ChapterRow[];
  files?: FileInfo[];
  chapterIndex: number;
  // When set, the modal shows this variant's text, chunk previews, and audio
  variant?: VariantRef | null;
  variants?: VariantRef[];
  onSwitchVariant?: (key: string | null) => void;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onQueue: (id: string, resume?: boolean) => void;
  onSetSelected: (id: string, selected: boolean) => void;
  // Voice the next synthesis will use for this view (variant lane or book)
  synthVoice?: string;
  // Changes the stored voice for the whole book (or the active variant lane)
  onChangeSynthVoice?: (voice: string) => void;
};

export function chapterAudioDownload(chapter: ChapterRow, variant?: VariantRef | null) {
  // Legacy chapters synthesized before the AAC switch are still .mp3 on disk
  const ext = chapter.audioPath?.match(/\.\w+$/)?.[0] ?? ".m4a";
  return {
    href: chapter.audioUrl ?? `/audio/chapter/${chapter.id}`,
    filename: `${chapter.index + 1} ${chapter.title}${variant ? ` (${variant.label ?? variant.key})` : ""}${ext}`.replace(/[\\/]/g, "-"),
  };
}

type SourceBlock = {
  type: string;
  text: string;
  page: number;
  included: boolean;
  level?: number;
  polygon?: number[][];
};

// No sticky bar inside the panel, so the cue may sit closer to its top than in the reader
const MODAL_BAND: FollowBand = { top: 24, bottom: 90, landing: 0.25 };

// What the reader does inside the modal — the tab, the edit, the chunk, the open page — belongs to
// the chapter and lane it was done in. It is held against them rather than cleared by an effect, so
// arriving at another chapter reads as untouched in the same render that shows it.
type ModalUi = {
  picked: ViewMode | null;
  isEditing: boolean;
  selectedChunkPreviewUrl: string | null;
  // Bumped only on an explicit user selection (clicking a chunk button or its text) so the audio
  // auto-plays then — but NOT when a chunk is auto-selected programmatically during synthesis.
  playNonce: number;
  pdfPage: number | null;
};

const UNTOUCHED_UI: ModalUi = {
  picked: null,
  isEditing: false,
  selectedChunkPreviewUrl: null,
  playNonce: 0,
  pdfPage: null,
};

type ViewMode = "pages" | "text" | "custom" | "clean" | "raw" | "split" | "blocks";

// The open index is held across list changes — a filter or a delete can leave it past the end
export function ChapterModal(props: ChapterModalProps) {
  const chapter = props.chapters[props.chapterIndex];
  if (!chapter) return null;
  return <ChapterModalBody {...props} chapter={chapter} />;
}

function ChapterModalBody({
  bookId,
  chapter,
  chapters,
  files,
  chapterIndex,
  variant,
  variants,
  onSwitchVariant,
  onClose,
  onNavigate,
  onQueue,
  onSetSelected,
  synthVoice,
  onChangeSynthVoice,
}: ChapterModalProps & { chapter: ChapterRow }) {
  useBodyScrollLock();
  const hasPrev = chapterIndex > 0;
  const hasNext = chapterIndex < chapters.length - 1;

  const [speed, setSpeed] = useState(loadSpeed);
  const [manifest, setManifest] = useState<ReaderManifest | null>(null);
  const playerRef = useRef<{ seek: (ms: number) => void; toggle: () => boolean } | null>(null);
  const [editText, setEditText] = useState("");

  const uiKey = `${chapterIndex}:${variant?.key ?? ""}`;
  const [uiState, setUiState] = useState<ModalUi & { key: string }>({ key: uiKey, ...UNTOUCHED_UI });
  const ui = uiState.key === uiKey ? uiState : { key: uiKey, ...UNTOUCHED_UI };
  const patchUi = useCallback(
    (patch: (current: ModalUi) => Partial<ModalUi>) =>
      setUiState((prev) => {
        const current = prev.key === uiKey ? prev : { key: uiKey, ...UNTOUCHED_UI };
        return { ...current, ...patch(current) };
      }),
    [uiKey],
  );

  const { picked, isEditing, selectedChunkPreviewUrl, playNonce, pdfPage } = ui;
  const setPicked = useCallback((mode: ViewMode | null) => patchUi(() => ({ picked: mode })), [patchUi]);
  const setIsEditing = useCallback((editing: boolean) => patchUi(() => ({ isEditing: editing })), [patchUi]);
  const setSelectedChunkPreviewUrl = useCallback((url: string | null) => patchUi(() => ({ selectedChunkPreviewUrl: url })), [patchUi]);
  const setPdfPage = useCallback((page: number | null) => patchUi(() => ({ pdfPage: page })), [patchUi]);
  const selectChunk = useCallback(
    (url: string) => patchUi((current) => ({ selectedChunkPreviewUrl: url, playNonce: current.playNonce + 1 })),
    [patchUi],
  );

  // Shared so hovering a chunk button highlights its text span and vice versa.
  const [hoveredChunkUrl, setHoveredChunkUrl] = useState<string | null>(null);

  const [showCompare, setShowCompare] = useState(false);
  const [showAi, setShowAi] = useState(false);

  const isVariant = !!variant;

  // Both documents change under an open modal: synthesis writes the audio and the text map that
  // puts its words on the page, and an edit leaves that map describing text nobody will hear.
  // Neither is a reload, so the fetches below key on both rather than on the audio alone.
  const revision = `${chapter.audioPath ?? ""}:${chapter.hasCustomText}`;

  useEffect(() => {
    fetchManifest(bookId).then(setManifest).catch(() => setManifest(null));
  }, [bookId, revision]);

  const readerChapter = manifest?.chapters.find((entry) => entry.i === chapter.index);
  // Where a chapter sits in the book survives an edit or a translation; marking the audio on it does not
  const hasPages = readerChapter?.pageStart != null;

  // The manifest states where a chapter's narration lives; nothing here builds that URL itself
  const cueUrl = isVariant ? null : readerChapter?.audio ? readerChapter.cues : null;

  // A re-synthesis leaves the cue URL untouched and its contents replaced, so the URL alone is not
  // enough to know the timings are the ones on disk. The timings and the playhead carry the version
  // they belong to, so a re-synthesis or an edit reads as unmarked until the new ones arrive.
  const cueKey = cueUrl ? `${cueUrl}:${revision}` : null;
  const [loadedCues, setLoadedCues] = useState<{ key: string; cues: ReaderCues | null } | null>(null);
  const cues = loadedCues?.key === cueKey ? loadedCues.cues : null;
  const [playhead, setPlayhead] = useState<{ key: string | null; ms: number }>({ key: null, ms: 0 });
  const ms = playhead.key === cueKey ? playhead.ms : 0;
  const setMs = useCallback((at: number) => setPlayhead({ key: cueKey, ms: at }), [cueKey]);

  useEffect(() => {
    if (!cueUrl || !cueKey) return;
    let live = true;
    fetchCues(cueUrl)
      .then((next) => { if (live) setLoadedCues({ key: cueKey, cues: next }); })
      .catch(() => { if (live) setLoadedCues({ key: cueKey, cues: null }); });
    return () => { live = false; };
  }, [cueUrl, cueKey]);

  const canMark = readerChapter?.mode === "page" && cues !== null;

  // Reading along on the page is the experience; the transcript is the fallback that still marks
  // words. A tab the reader picks outranks both, and is dropped when the chapter changes.
  const viewMode: ViewMode =
    picked ?? (canMark ? "pages" : cues ? "text" : chapter.hasCustomText ? "custom" : chapter.hasCleanText ? "clean" : "raw");

  // The modal scrolls its own panel rather than the window, which followCue works out for itself
  useFollowCue(cues, ms, MODAL_BAND, `${chapter.id}:${viewMode}`);

  const isTranslationKind = variant?.kind === "translation";
  const variantName = variant ? variant.label ?? variant.key : null;
  // Why the page below carries no highlight — the alternative is a reader waiting for one. Only
  // the lane being read and the missing audio are this component's to know; the rest the document says.
  const markReason = variantName
    ? `Audio for the ${variantName} text can't be marked on the page. These are the chapter's pages in the original.`
    : !readerChapter?.audio
      ? "Synthesize this chapter to follow the narration on these pages."
      : `${UNMAPPED[readerChapter.why ?? "unmapped"]} These are the chapter's pages in the original.`;
  const { data: originalChapter, isLoading: originalLoading } = trpc.chapters.get.useQuery(
    { id: chapter.id },
    { enabled: !isVariant, refetchInterval: chapter.status === "synthesizing" ? 1000 : false },
  );
  const { data: variantDetail, isLoading: variantLoading } = trpc.variants.detail.useQuery(
    { chapterId: chapter.id, key: variant?.key ?? "" },
    {
      enabled: isVariant,
      retry: false,
      // A variant's audio run only moves audioStatus — chapters.status and the variant's own
      // text status both stay "done" — so polling has to watch that field or it never runs.
      refetchInterval: (query) => {
        const d = query.state.data;
        const busy =
          d?.status === "pending" ||
          d?.status === "translating" ||
          d?.audioStatus === "pending" ||
          d?.audioStatus === "synthesizing" ||
          chapter.status === "synthesizing";
        return busy ? 1000 : false;
      },
    },
  );
  const fullChapter = isVariant
    ? variantDetail && {
        rawText: variantDetail.text,
        cleanText: null,
        customText: null,
        sourceBlocks: null,
        chunkTextSource: "raw" as const,
        chunkPreviews: variantDetail.chunkPreviews,
      }
    : originalChapter;
  const isLoading = isVariant ? variantLoading : originalLoading;

  // Chunk previews and cues both count sync-map chunks, so hovering either side lights the other
  const hoverChunk = hoveredChunkUrl
    ? (fullChapter?.chunkPreviews.find((preview) => preview.url === hoveredChunkUrl)?.index ?? 0) - 1
    : null;
  const hoverCue = (index: number | null) => {
    const cue = index === null ? null : cues?.cues[index];
    const preview = cue ? fullChapter?.chunkPreviews.find((entry) => entry.index === cue.c + 1) : undefined;
    setHoveredChunkUrl(preview?.url ?? null);
  };
  const utils = trpc.useUtils();

  // Polling stops the instant synthesis ends, but the worker deletes the chunk WAVs when it builds
  // the sync map — so without one final fetch the panel keeps pointing at files that no longer
  // exist and play() fails silently until a page reload. Variants track their own audioStatus.
  const audioBusy = isVariant
    ? variantDetail?.audioStatus === "synthesizing" || variantDetail?.audioStatus === "pending"
    : chapter.status === "synthesizing";
  // Partial audio exists, so "start over" and "carry on" are genuinely different actions here.
  const canContinueSynthesis = chapter.status === "suspended" || chapter.status === "failed";
  const withVoice = synthVoice ? ` with ${getVoiceLabel(synthVoice)}` : "";
  const wasAudioBusyRef = useRef(audioBusy);
  useEffect(() => {
    const was = wasAudioBusyRef.current;
    wasAudioBusyRef.current = audioBusy;
    if (!was || audioBusy) return;
    utils.chapters.get.invalidate({ id: chapter.id });
    if (variant?.key) utils.variants.detail.invalidate({ chapterId: chapter.id, key: variant.key });
  }, [audioBusy, chapter.id, variant?.key, utils]);

  // The one selection here that cannot be derived during render: which chunk is chosen when nobody
  // has chosen one depends on when the list first arrived, and it stays put as the list grows.
  useEffect(() => {
    const previews = fullChapter?.chunkPreviews ?? [];
    if (selectedChunkPreviewUrl && previews.some((preview) => preview.url === selectedChunkPreviewUrl)) return;
    if (previews.length === 0 && selectedChunkPreviewUrl === null) return;
    // While synthesizing, follow the latest chunk; otherwise default to the first so playback
    // (and the play button) starts from the beginning of the chapter.
    const fallback = (chapter.status === "synthesizing" ? previews.at(-1) : previews[0])?.url ?? null;
    // eslint-disable-next-line react/set-state-in-effect -- sticky from the moment the chunks appear, so it is not a function of this render's props
    setSelectedChunkPreviewUrl(fallback);
  }, [fullChapter?.chunkPreviews, chapter.status, selectedChunkPreviewUrl, setSelectedChunkPreviewUrl]);

  const updateTextMutation = trpc.chapters.updateText.useMutation({
    onSuccess: () => {
      utils.chapters.get.invalidate({ id: chapter.id });
      utils.books.get.invalidate();
      setIsEditing(false);
    },
  });

  const resetTextMutation = trpc.chapters.resetText.useMutation({
    onSuccess: () => {
      utils.chapters.get.invalidate({ id: chapter.id });
      utils.books.get.invalidate();
    },
  });

  const refreshVariants = () => {
    utils.variants.detail.invalidate();
    utils.variants.listForBook.invalidate();
    utils.variants.list.invalidate();
    utils.books.logs.invalidate();
  };
  const startVariantMutation = trpc.variants.start.useMutation({ onSuccess: refreshVariants });
  const stopVariantMutation = trpc.variants.stop.useMutation({ onSuccess: refreshVariants });

  const invalidateCleanup = () => {
    utils.books.get.invalidate();
    utils.chapters.get.invalidate({ id: chapter.id });
    utils.books.logs.invalidate();
  };
  const queueCleanupMutation = trpc.chapters.queueCleanup.useMutation({ onSuccess: invalidateCleanup });
  const stopCleanupMutation = trpc.chapters.stopCleanup.useMutation({ onSuccess: invalidateCleanup });

  const cleanupStatus = chapter.cleanup?.status;
  const cleanupRunning = cleanupStatus === "pending" || cleanupStatus === "cleaning";
  // books.get polling flips the status while this modal is open; the text itself lives in chapters.get
  const wasCleaningRef = useRef(false);
  useEffect(() => {
    if (wasCleaningRef.current && !cleanupRunning) {
      utils.chapters.get.invalidate({ id: chapter.id });
    }
    wasCleaningRef.current = cleanupRunning;
  }, [cleanupRunning, chapter.id, utils]);
  const cleanupLabel =
    cleanupRunning ? "Cleaning..." :
    cleanupStatus === "failed" ? "Retry cleanup" :
    cleanupStatus === "done" ? "Re-clean" :
    "Cleanup (AI)";

  const variantStatus = isVariant ? variantDetail?.status : undefined;
  const variantRunning = variantStatus === "pending" || variantStatus === "translating";
  const runLabel =
    variantStatus === "suspended" ? "Resume" :
    variantStatus === "failed" ? "Retry" :
    variantStatus === "done" ? (isTranslationKind ? "Re-translate" : "Re-run") :
    (isTranslationKind ? "Translate" : "Run");

  function handleRunVariant() {
    startVariantMutation.mutate({
      chapterId: chapter.id,
      key: variant!.key,
      restart: variantStatus === "done",
    });
  }

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // The chapter's own audio, which the preview panel falls back to once the chunks are gone — one
  // player for one file, rather than a second control for it on the busiest line in the modal
  const chapterAudioUrl =
    chapter.status === "done" && chapter.audioPath ? chapter.audioUrl ?? `/audio/chapter/${chapter.id}` : null;

  const changeSpeed = useCallback((rate: number) => {
    setSpeed(rate);
    saveSpeed(rate);
  }, []);

  const togglePlay = useCallback(() => playerRef.current?.toggle() ?? false, []);
  usePlayPauseKey(togglePlay, !isEditing && !showCompare && pdfPage === null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // The compare overlay has its own Escape handler — this one must not double-close.
      if (isEditing || showCompare) return;
      if (e.key === "Escape") {
        if (pdfPage !== null) setPdfPage(null);
        else onClose();
      }
      if (e.key === "ArrowLeft" && hasPrev) onNavigate(chapterIndex - 1);
      if (e.key === "ArrowRight" && hasNext) onNavigate(chapterIndex + 1);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, isEditing, showCompare, hasPrev, hasNext, chapterIndex, onNavigate, pdfPage, setPdfPage]);

  function startEditing() {
    if (!fullChapter) return;
    setEditText(fullChapter.customText ?? fullChapter.cleanText ?? fullChapter.rawText);
    setIsEditing(true);
  }

  function handleSave() {
    if (!editText.trim()) return;
    updateTextMutation.mutate({ id: chapter.id, customText: editText });
  }

  function handleReset() {
    if (!confirm("Reset to original text? Your edits will be lost.")) return;
    resetTextMutation.mutate({ id: chapter.id });
  }

  // Clickable chunk ranges for the text panel — only when the active view renders the same text
  // the chunk offsets point into (chunkTextSource). Selecting a span mirrors the chunk buttons.
  const activeChunkUrl = selectedChunkPreviewUrl ?? fullChapter?.chunkPreviews.at(-1)?.url ?? null;
  const sourceFile =
    files?.find((f) => f.index === chapter.sourceFileIndex) ?? (files?.length === 1 ? files[0] : undefined);
  const activeChunkPage = fullChapter?.chunkPreviews.find((p) => p.url === activeChunkUrl)?.page ?? null;
  const chunkRanges =
    fullChapter && viewMode === fullChapter.chunkTextSource
      ? fullChapter.chunkPreviews.flatMap((p) =>
          typeof p.start === "number" && typeof p.end === "number"
            ? [{ start: p.start, end: p.end, url: p.url }]
            : [],
        )
      : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid="chapter-modal">
      <div className="absolute inset-0 bg-(--scrim)" onClick={onClose} />
      {hasPrev ? (
        <a
          href="#prev"
          onClick={(e) => { e.preventDefault(); onNavigate(chapterIndex - 1); }}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-10 h-10 flex items-center justify-center rounded-full bg-(--bg-card)/90 shadow-md border border-(--border) text-(--text-muted) hover:text-(--text-primary) hover:bg-(--bg-card) transition-colors text-xl font-light select-none no-underline"
          title="Previous chapter (←)"
        >
          &lt;
        </a>
      ) : null}
      {hasNext ? (
        <a
          href="#next"
          onClick={(e) => { e.preventDefault(); onNavigate(chapterIndex + 1); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-10 h-10 flex items-center justify-center rounded-full bg-(--bg-card)/90 shadow-md border border-(--border) text-(--text-muted) hover:text-(--text-primary) hover:bg-(--bg-card) transition-colors text-xl font-light select-none no-underline"
          title="Next chapter (→)"
        >
          &gt;
        </a>
      ) : null}
      <div className="relative bg-(--bg-card) rounded-xl shadow-2xl w-[92vw] max-w-6xl h-[92vh] flex flex-col">
        <div className="flex items-start justify-between p-5 border-b border-(--border)">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <input
                type="checkbox"
                checked={chapter.selected}
                onChange={() => onSetSelected(chapter.id, !chapter.selected)}
                className="rounded border-(--border-input) text-(--accent-text)"
              />
              <span className="text-sm font-mono text-(--text-faint)">#{chapter.index + 1}</span>
              <h2 className="text-lg font-semibold text-(--text-primary) truncate">{chapter.title}</h2>
              <StatusBadge status={chapter.status} error={chapter.error} />
              {!isVariant && chapter.cleanup?.status === "done" ? (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--success-bg) text-(--success-text)"
                  title="Cleaned by AI — the custom text holds the result"
                >
                  cleaned
                </span>
              ) : chapter.hasCustomText ? (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--warning-bg) text-(--warning-text) hover:bg-(--warning)/25">
                  edited
                </span>
              ) : null}
            </div>
            <div className="flex gap-4 text-xs text-(--text-muted)">
              <span>{chapter.wordCount.toLocaleString()} words</span>
              {chapter.durationMs ? (
                <span>{formatDuration(chapter.durationMs)}</span>
              ) : null}
              {chapter.pageStart ? (
                sourceFile ? (
                  <button
                    onClick={() => setPdfPage(chapter.pageStart!)}
                    className="tabular-nums text-(--accent-text) hover:text-(--accent-text-hover)"
                    title="Open the source PDF at this chapter's first page"
                  >
                    p.{chapter.pageStart}{chapter.pageEnd && chapter.pageEnd !== chapter.pageStart ? `–${chapter.pageEnd}` : ""}
                  </button>
                ) : (
                  <span className="tabular-nums">
                    p.{chapter.pageStart}{chapter.pageEnd && chapter.pageEnd !== chapter.pageStart ? `–${chapter.pageEnd}` : ""}
                  </span>
                )
              ) : null}
              {hasPages ? (
                canMark ? (
                  <Link
                    to={`/books/${bookId}/read?chapter=${chapter.index}`}
                    className="text-(--accent-text) hover:text-(--accent-text-hover)"
                    title="Follow the narration on the page itself, at full size"
                    data-testid="chapter-read-along"
                  >
                    Read along on the page
                  </Link>
                ) : (
                  <span className="text-(--text-faint) cursor-help" title={markReason} data-testid="chapter-read-along-off">
                    Read along on the page
                  </span>
                )
              ) : null}
              {chapter.progress && chapter.status === "synthesizing" ? (
                <span className="text-(--accent-text) font-medium">Chunk {chapter.progress}</span>
              ) : null}
              {chapter.progress && chapter.status === "suspended" ? (
                <span className="text-(--text-muted) font-medium">{chapter.progress} synthesized</span>
              ) : null}
              {chapter.synthesizedWith?.voice ? (
                <span>{getVoiceLabel(chapter.synthesizedWith.voice)}</span>
              ) : null}
              {chapter.synthesizedWith?.speed !== null && chapter.synthesizedWith?.speed !== undefined ? (
                <span>{chapter.synthesizedWith.speed}x</span>
              ) : null}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1 text-(--text-faint) hover:text-(--text-tertiary) rounded"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 py-2 border-b border-(--border) bg-(--bg-subtle)">
          {chapter.status === "done" && chapter.audioPath ? (
            <a
              href={chapterAudioDownload(chapter, variant).href}
              download={chapterAudioDownload(chapter, variant).filename}
              title={`Download the ${variantName ?? "chapter"} audio`}
              className={`${TOOLBAR_BUTTON} no-underline`}
            >
              Download
            </a>
          ) : (
            <button
              disabled
              title={`No ${variantName ?? "chapter"} audio to download yet`}
              className={TOOLBAR_BUTTON}
            >
              Download
            </button>
          )}

          <Divider />

          {/* The voice is the input to the buttons beside it, so it leads the group rather than
              trailing it — and it opens a modal, so it must not read as a <select>. */}
          {synthVoice && onChangeSynthVoice ? (
            <VoicePickerChip
              value={synthVoice}
              onChange={onChangeSynthVoice}
              title={`Voice for the next synthesis — changing it applies to the whole ${isVariant ? `${variantName} lane` : "book"}`}
            />
          ) : synthVoice ? (
            <span
              className="text-xs text-(--text-faint)"
              title={`Next synthesis uses this voice — change it via "Synthesize selected" above the chapter table`}
            >
              {getVoiceLabel(synthVoice)}
            </span>
          ) : null}
          {canContinueSynthesis ? (
            <button
              onClick={() => onQueue(chapter.id, true)}
              title="Continue synthesis from where it stopped — keeps the chunks already synthesized"
              className="text-xs px-2.5 py-1 rounded bg-(--accent) text-(--on-accent) hover:bg-(--accent-hover) font-medium"
            >
              Continue{chapter.progress ? ` (${chapter.progress})` : ""}
            </button>
          ) : null}
          <button
            onClick={() => onQueue(chapter.id)}
            disabled={["pending", "normalizing", "synthesizing"].includes(chapter.status) || chapter.synthesizable === false}
            title={
              chapter.synthesizable === false
                ? `No finished ${variantName} text for this chapter`
                : ["pending", "normalizing", "synthesizing"].includes(chapter.status)
                  ? "Can't re-synthesize while it's being processed"
                  : canContinueSynthesis
                    ? `Discard the ${chapter.progress ?? "already-synthesized"} chunks and synthesize the whole chapter again${withVoice}`
                    : `Re-synthesize this chapter's audio from text (from scratch)${withVoice}`
            }
            className={TOOLBAR_BUTTON}
            data-testid="chapter-synthesize"
          >
            {canContinueSynthesis ? "Start over" : "Re-synthesize"}
          </button>

          <Divider />

          <button
            onClick={() => setShowAi(true)}
            title="Summarize, question, or run any prompt against this chapter's text"
            className={TOOLBAR_BUTTON}
            data-testid="chapter-ask-ai"
          >
            Ask AI
          </button>
          {!isVariant ? (
            <>
              <button
                onClick={() => queueCleanupMutation.mutate({ id: chapter.id })}
                disabled={cleanupRunning || queueCleanupMutation.isPending}
                title={
                  cleanupRunning ? "Cleanup is running" :
                  cleanupStatus === "failed" ? "Retry the failed cleanup" :
                  cleanupStatus === "done" ? "Run the AI cleanup again on the current text" :
                  "Ask AI to strip OCR artifacts from this chapter without altering the prose"
                }
                className={TOOLBAR_BUTTON}
                data-testid="chapter-cleanup"
              >
                {cleanupLabel}
              </button>
              <button
                onClick={() => stopCleanupMutation.mutate({ id: chapter.id })}
                disabled={!cleanupRunning || stopCleanupMutation.isPending}
                title={cleanupRunning ? "Stop the cleanup — the chapter text stays unchanged" : "Nothing is running"}
                className={TOOLBAR_BUTTON}
                data-testid="chapter-cleanup-stop"
              >
                Stop cleanup
              </button>
              {cleanupRunning ? (
                <span className="text-xs text-(--badge-normalizing-text)" data-testid="chapter-cleanup-progress">
                  Cleaning{chapter.cleanup?.progress ? ` · ${chapter.cleanup.progress} chunks` : ""}...
                </span>
              ) : cleanupStatus === "failed" && chapter.cleanup?.error ? (
                <span className="text-xs text-(--danger-text) truncate" title={chapter.cleanup.error}>
                  Cleanup failed: {chapter.cleanup.error}
                </span>
              ) : null}
              {queueCleanupMutation.error || stopCleanupMutation.error ? (
                <span className="text-xs text-(--danger-text) truncate">
                  {(queueCleanupMutation.error ?? stopCleanupMutation.error)?.message}
                </span>
              ) : null}
            </>
          ) : null}
          {isVariant ? (
            <>
              <button
                onClick={handleRunVariant}
                disabled={variantRunning || startVariantMutation.isPending}
                title={
                  variantRunning ? `${variantName} is running` :
                  variantStatus === "suspended" ? "Continue from where it stopped" :
                  variantStatus === "failed" ? "Retry the failed run" :
                  variantStatus === "done" ? `Discard this ${variantName} text and generate it again` :
                  isTranslationKind ? `Translate this chapter to ${variantName}` : `Rewrite this chapter as ${variantName}`
                }
                className="text-xs px-2.5 py-1 rounded bg-(--accent) text-(--on-accent) hover:bg-(--accent-hover) font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="chapter-translate"
              >
                {runLabel}
              </button>
              <button
                onClick={() => stopVariantMutation.mutate({ chapterId: chapter.id, key: variant!.key })}
                disabled={!variantRunning || stopVariantMutation.isPending}
                title={variantRunning ? "Stop and keep everything generated so far" : "Nothing is running"}
                className={TOOLBAR_BUTTON}
                data-testid="chapter-translate-stop"
              >
                Stop {isTranslationKind ? "translation" : "rewrite"}
              </button>
              <button
                onClick={() => setShowCompare(true)}
                title="Review the original and this variant side by side"
                className={TOOLBAR_BUTTON}
                data-testid="chapter-compare"
              >
                Compare
              </button>
              {variantRunning ? (
                <span className="text-xs text-(--accent-text)" data-testid="chapter-translation-progress">
                  {isTranslationKind ? "Translating" : "Rewriting"}{variantDetail?.progress ? ` · ${variantDetail.progress} chunks` : ""}...
                </span>
              ) : variantStatus === "failed" && variantDetail?.error ? (
                <span className="text-xs text-(--danger-text) truncate" title={variantDetail.error}>
                  Failed: {variantDetail.error}
                </span>
              ) : null}
              {startVariantMutation.error || stopVariantMutation.error ? (
                <span className="text-xs text-(--danger-text) truncate">
                  {(startVariantMutation.error ?? stopVariantMutation.error)?.message}
                </span>
              ) : null}
            </>
          ) : null}
          <div className="flex-1" />
          {onSwitchVariant && variants && variants.length > 0 && !isEditing ? (
            <div className="flex items-center gap-1 mr-2" data-testid="modal-language-switcher">
              <PillToggle selected={!variant} onClick={() => onSwitchVariant(null)}>
                Original
              </PillToggle>
              {variants.map((v) => (
                <PillToggle
                  key={v.key}
                  selected={variant?.key === v.key}
                  onClick={() => onSwitchVariant(v.key)}
                >
                  {v.label ?? v.key}
                </PillToggle>
              ))}
            </div>
          ) : null}
          {isEditing ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={updateTextMutation.isPending}
                className="text-xs px-2.5 py-1 rounded bg-(--success) text-(--on-success) hover:bg-(--success-hover) font-medium disabled:opacity-50"
                data-testid="chapter-edit-save"
              >
                {updateTextMutation.isPending ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="text-xs px-2.5 py-1 rounded bg-(--bg-subtle) text-(--text-tertiary) hover:bg-(--border) font-medium"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {chapter.hasCustomText ? (
                <button
                  onClick={handleReset}
                  disabled={resetTextMutation.isPending}
                  className="text-xs px-2.5 py-1 rounded bg-(--danger-bg) text-(--danger-text) hover:bg-(--danger)/20 font-medium disabled:opacity-50"
                >
                  Reset
                </button>
              ) : null}
              {fullChapter && !isVariant ? (
                <button
                  onClick={startEditing}
                  // Warning tint on purpose: saving custom text drops the chapter to mode "text"
                  // (reader-doc.ts) and the read-along stops following the PDF page.
                  className="text-xs px-2.5 py-1 rounded bg-(--warning-bg) text-(--warning-text) font-medium"
                  data-testid="chapter-edit"
                >
                  Edit
                </button>
              ) : null}
              <ViewModeTabs
                viewMode={viewMode}
                onSetViewMode={setPicked}
                hasCues={cues !== null}
                hasPages={hasPages}
                hasCleanText={chapter.hasCleanText}
                hasCustomText={chapter.hasCustomText}
                hasSourceBlocks={chapter.hasSourceBlocks}
              />
            </div>
          )}
        </div>

        {chapterAudioUrl || fullChapter?.chunkPreviews.length ? (
          <ChunkPreviewPanel
            chunkPreviews={fullChapter?.chunkPreviews ?? []}
            audioUrl={chapterAudioUrl}
            selectedUrl={selectedChunkPreviewUrl}
            onSelect={selectChunk}
            onFollow={setSelectedChunkPreviewUrl}
            playNonce={playNonce}
            hoveredUrl={hoveredChunkUrl}
            onHover={setHoveredChunkUrl}
            isSynthesizing={chapter.status === "synthesizing"}
            sourcePage={activeChunkPage}
            canOpenPdf={sourceFile !== undefined}
            onOpenPdf={setPdfPage}
            onTime={setMs}
            playerRef={playerRef}
            follows={viewMode === "pages" || viewMode === "text"}
            playbackRate={speed}
            onPlaybackRate={changeSpeed}
          />
        ) : null}

        <div className="flex-1 min-h-[40vh] flex flex-col p-5">
          {isLoading ? (
            <div className="flex items-center justify-center flex-1 text-sm text-(--text-faint)">
              Loading text...
            </div>
          ) : fullChapter ? (
            isEditing ? (
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                data-testid="chapter-edit-text"
                className="flex-1 min-h-0 w-full max-w-prose mx-auto rounded bg-(--bg-reading) border border-(--border-custom-text) px-7 py-6 font-reading text-[17px] text-(--text-primary) whitespace-pre-wrap leading-relaxed resize-none"
              />
            ) : viewMode === "pages" && manifest && readerChapter ? (
              <div className="mx-auto flex w-full max-w-3xl flex-1 min-h-0 flex-col gap-4 overflow-y-auto">
                {canMark ? null : (
                  <p
                    className="rounded border border-(--border) bg-(--bg-subtle) px-3 py-2 text-xs text-(--text-muted)"
                    data-testid="pages-unmarked"
                  >
                    {markReason}
                  </p>
                )}
                <CuePages
                  manifest={manifest}
                  chapter={readerChapter}
                  cues={canMark ? cues : null}
                  ms={ms}
                  columns
                  onSeek={(at) => playerRef.current?.seek(at)}
                  hoverChunk={hoverChunk}
                  onHoverCue={hoverCue}
                />
              </div>
            ) : viewMode === "text" && cues ? (
              <CueTranscript
                cues={cues}
                ms={ms}
                onSeek={(at) => playerRef.current?.seek(at)}
                hoverChunk={hoverChunk}
                onHoverCue={hoverCue}
                className="mx-auto w-full max-w-prose flex-1 min-h-0 overflow-y-auto rounded bg-(--bg-reading) border border-(--border-reading) px-7 py-6 font-reading text-[17px] leading-relaxed text-(--text-primary)"
              />
            ) : viewMode === "blocks" && fullChapter.sourceBlocks ? (
              <BlocksPreview
                sourceBlocks={fullChapter.sourceBlocks as SourceBlock[]}
                onOpenPdf={sourceFile ? setPdfPage : undefined}
              />
            ) : isVariant && !fullChapter.rawText ? (
              <div className="flex items-center justify-center flex-1 text-sm text-(--text-muted)">
                {variantRunning ? "Waiting for the first chunk..." : `No ${variantName} text yet.`}
              </div>
            ) : (
              <TextPreview
                rawText={fullChapter.rawText}
                cleanText={fullChapter.cleanText}
                customText={fullChapter.customText}
                viewMode={viewMode}
                chunkRanges={chunkRanges}
                selectedChunkUrl={activeChunkUrl}
                onSelectChunk={selectChunk}
                hoveredChunkUrl={hoveredChunkUrl}
                onHoverChunk={setHoveredChunkUrl}
              />
            )
          ) : isVariant ? (
            <div className="flex flex-col items-center justify-center gap-3 flex-1 text-sm text-(--text-muted)">
              <span>No {variantName} text for this chapter yet.</span>
              <button
                onClick={handleRunVariant}
                disabled={startVariantMutation.isPending}
                className="text-xs px-3 py-1.5 rounded bg-(--accent) text-(--on-accent) hover:bg-(--accent-hover) font-medium disabled:opacity-50"
                data-testid="chapter-translate-empty"
              >
                {startVariantMutation.isPending ? "Starting..." : isTranslationKind ? `Translate to ${variantName}` : `Generate ${variantName}`}
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-center flex-1 text-sm text-(--text-muted)">
              Failed to load chapter text
            </div>
          )}
        </div>
      </div>
      {pdfPage !== null && sourceFile ? (
        <PdfPreviewModal
          fileId={sourceFile.id}
          page={pdfPage}
          filename={sourceFile.filename}
          onClose={() => setPdfPage(null)}
        />
      ) : null}
      {showAi ? (
        <ChapterAiModal
          scope={{ kind: "chapters", bookId, chapters: [{ id: chapter.id, title: chapter.title }] }}
          onClose={() => setShowAi(false)}
        />
      ) : null}
      {showCompare && variant ? (
        <VariantModal
          bookId={bookId}
          chapters={chapters}
          initialKey={variant.key}
          initialChapterId={chapter.id}
          onClose={() => {
            setShowCompare(false);
            refreshVariants();
          }}
        />
      ) : null}
    </div>
  );
}

function ChunkPreviewPanel({
  chunkPreviews,
  audioUrl,
  selectedUrl,
  onSelect,
  onFollow,
  playNonce,
  hoveredUrl,
  onHover,
  isSynthesizing,
  sourcePage,
  canOpenPdf,
  onOpenPdf,
  onTime,
  playerRef,
  follows,
  playbackRate,
  onPlaybackRate,
}: {
  chunkPreviews: Array<{ index: number; fileName: string; url: string; page?: number; startMs?: number; endMs?: number }>;
  audioUrl: string | null;
  selectedUrl: string | null;
  onSelect: (url: string) => void;
  // Selection driven by playback progress — highlights without re-triggering auto-play
  onFollow: (url: string) => void;
  playNonce: number;
  hoveredUrl: string | null;
  onHover: (url: string | null) => void;
  isSynthesizing: boolean;
  sourcePage: number | null;
  canOpenPdf: boolean;
  onOpenPdf: (page: number) => void;
  onTime: (ms: number) => void;
  playerRef: React.RefObject<{ seek: (ms: number) => void; toggle: () => boolean } | null>;
  // Whether the open view marks the words, and so needs a position finer than timeupdate's
  follows: boolean;
  playbackRate: number;
  onPlaybackRate: (rate: number) => void;
}) {
  const activeUrl = selectedUrl ?? chunkPreviews.at(-1)?.url ?? null;
  const activeIndex = chunkPreviews.findIndex((preview) => preview.url === activeUrl);
  const activeChunk = activeIndex >= 0 ? chunkPreviews[activeIndex] : undefined;
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeButtonRef = useRef<HTMLButtonElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // After cleanup the chunk WAVs are gone: entries carry sync-map timings instead, and the
  // panel plays the chapter audio, seeking to each chunk's startMs.
  const syncMode = typeof chunkPreviews[0]?.startMs === "number";
  const audioSrc = (syncMode ? activeUrl?.split("#")[0] : activeUrl) ?? audioUrl;
  const pendingSeekRef = useRef<number | null>(null);

  // Ref mirror of the chosen rate so play handlers always read the latest without stale closures.
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  function playActive() {
    const audio = audioRef.current;
    if (!audio) return;
    if (pendingSeekRef.current !== null && audio.readyState >= 1) {
      audio.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
    }
    // Apply the speed only after play() resolves: by then the load has settled, so the browser
    // won't snap playbackRate back to 1x (which is what happens if you set it before the load).
    audio.play().then(() => { audio.playbackRate = playbackRateRef.current; }).catch(() => {});
  }

  // Apply speed changes immediately while a chunk is already playing — and again whenever the
  // element loads another one, since a load resets playbackRate to defaultPlaybackRate.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.defaultPlaybackRate = playbackRate;
    audio.playbackRate = playbackRate;
  }, [playbackRate, audioSrc]);

  // Auto-play whenever the user explicitly picks a chunk (playNonce changes), but not on the
  // programmatic auto-select during synthesis (playNonce stays 0 then) — and not on a mount, which
  // is a panel rebuilt around another chapter rather than anyone asking to hear it.
  //
  // The chunk to play is read through a ref rather than declared: it is the nonce alone that says
  // someone asked to hear one, and re-running this as chunks arrive would play one nobody picked.
  const played = useRef(false);
  const asked = useRef({ syncMode, chunkPreviews, activeUrl });
  useEffect(() => {
    asked.current = { syncMode, chunkPreviews, activeUrl };
  });
  useEffect(() => {
    if (!played.current) {
      played.current = true;
      return;
    }
    if (playNonce > 0) {
      const { syncMode: sync, chunkPreviews: previews, activeUrl: url } = asked.current;
      if (sync) {
        const target = previews.find((preview) => preview.url === url);
        if (typeof target?.startMs === "number") pendingSeekRef.current = target.startMs / 1000;
      }
      playActive();
    }
  }, [playNonce]);

  // Only a view that marks the words needs a position finer than timeupdate's — and only that view
  // is worth re-rendering for. Outside sync mode the element is one chunk's own file, so its clock
  // is chunk-relative and says nothing about where the chapter's cues are.
  useAudioTime(audioRef, isPlaying && follows && syncMode, onTime);

  useEffect(() => {
    playerRef.current = {
      seek: (ms: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        onTime(ms);
        // preload="none" means currentTime is ignored until metadata arrives; the pending seek
        // is applied by playActive and by loadedmetadata, whichever gets there first
        pendingSeekRef.current = ms / 1000;
        playActive();
      },
      toggle: () => {
        if (!audioSrc) return false;
        togglePlay();
        return true;
      },
    };
    return () => { playerRef.current = null; };
  }, [playerRef, onTime, audioSrc]);

  function handleTimeUpdate() {
    const audio = audioRef.current;
    if (!syncMode || !audio) return;
    onTime(audio.currentTime * 1000);
    if (audio.paused) return;
    const ms = audio.currentTime * 1000;
    const current = chunkPreviews.find(
      (preview) => preview.startMs! <= ms && ms < preview.endMs!,
    );
    if (current && current.url !== activeUrl) onFollow(current.url);
  }

  // Keep the active chunk's button visible in the scrollable list when the selection changes.
  useEffect(() => {
    activeButtonRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeUrl]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) playActive();
    else audio.pause();
  }

  // When a chunk finishes, roll on to the next one (audiobook-style). Selecting it bumps playNonce,
  // which auto-plays it. Pausing stops the chain since a paused chunk never fires "ended".
  // Sync mode plays one continuous file, so "ended" only fires at the end of the chapter.
  function handleEnded() {
    if (syncMode) {
      setIsPlaying(false);
      return;
    }
    const next = activeIndex >= 0 ? chunkPreviews[activeIndex + 1] : undefined;
    if (next) onSelect(next.url);
    else setIsPlaying(false);
  }

  return (
    <div className="border-b border-(--border) px-5 py-3 bg-(--bg-card)">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {activeUrl ? (
            <button
              onClick={togglePlay}
              title={isPlaying ? "Pause (space)" : "Play (space) — auto-advances through chunks"}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-(--accent) text-(--on-accent) hover:bg-(--accent-hover)"
            >
              {isPlaying ? (
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M6 4h3v12H6zM11 4h3v12h-3z" />
                </svg>
              ) : (
                <svg className="h-3.5 w-3.5 translate-x-px" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M6 4l10 6-10 6V4z" />
                </svg>
              )}
            </button>
          ) : null}
          {activeUrl ? (
            <select
              value={playbackRate}
              onChange={(e) => onPlaybackRate(Number(e.target.value))}
              title="Playback speed"
              className="rounded border border-(--border) bg-(--bg-subtle) px-1 py-0.5 text-xs text-(--text-tertiary)"
            >
              {SPEEDS.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}x
                </option>
              ))}
            </select>
          ) : null}
          <div className="text-xs font-medium text-(--text-primary)">
            {chunkPreviews.length === 0
              ? "Chapter audio"
              : `Chunk previews ${isSynthesizing ? `(live: ${chunkPreviews.length} ready)` : `(${chunkPreviews.length})`}`}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onOpenPdf(sourcePage!)}
            disabled={!canOpenPdf || sourcePage === null}
            title={
              !canOpenPdf
                ? "Source PDF unknown for this chapter"
                : sourcePage === null
                  ? "No page info for this chunk"
                  : "Open the source PDF at this chunk's page"
            }
            className="text-xs text-(--accent-text) hover:text-(--accent-text-hover) disabled:opacity-40 disabled:cursor-not-allowed"
          >
            PDF{sourcePage !== null ? ` p.${sourcePage}` : ""}
          </button>
          <a
            href={chunkPreviews.at(-1)?.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-(--accent-text) hover:text-(--accent-text-hover)"
          >
            Open latest file
          </a>
        </div>
      </div>

      <div className="mb-3 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto pr-1 empty:mb-0">
        {chunkPreviews.map((preview) => {
          const active = preview.url === activeUrl;
          const linked = !active && preview.url === hoveredUrl;
          return (
            <button
              key={preview.fileName}
              ref={active ? activeButtonRef : undefined}
              onClick={() => onSelect(preview.url)}
              onMouseEnter={() => onHover(preview.url)}
              onMouseLeave={() => onHover(null)}
              title={preview.page !== undefined ? `PDF page ${preview.page}` : undefined}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${ active ? "bg-(--accent) text-(--on-accent)" : linked ? "bg-(--accent-subtle) text-(--text-primary)" : "bg-(--bg-subtle) text-(--text-tertiary) hover:bg-(--border)" }`}
            >
              Chunk {preview.index}
            </button>
          );
        })}
      </div>

      {audioSrc ? (
        <div className="flex items-center gap-2">
          {chunkPreviews.length > 0 ? (
            <span className="text-xs text-(--text-faint) shrink-0">Chunk {activeChunk?.index ?? "—"}</span>
          ) : null}
          <audio
            ref={audioRef}
            src={audioSrc}
            controls
            preload={syncMode ? "metadata" : "none"}
            className="h-8 w-full max-w-xl"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            // Scrubbing can reset the rate to 1x; re-assert the chosen speed after a seek.
            onSeeked={(e) => { e.currentTarget.playbackRate = playbackRateRef.current; }}
            onLoadedMetadata={(e) => {
              if (pendingSeekRef.current !== null) {
                e.currentTarget.currentTime = pendingSeekRef.current;
                pendingSeekRef.current = null;
              }
            }}
            onTimeUpdate={handleTimeUpdate}
            onEnded={handleEnded}
          />
        </div>
      ) : null}
    </div>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-(--border) shrink-0" aria-hidden="true" />;
}

function ViewModeTabs({
  viewMode,
  onSetViewMode,
  hasCleanText,
  hasCustomText,
  hasSourceBlocks,
  hasCues,
  hasPages,
}: {
  viewMode: ViewMode;
  onSetViewMode: (mode: ViewMode) => void;
  hasCleanText: boolean;
  hasCustomText: boolean;
  hasSourceBlocks: boolean;
  hasCues: boolean;
  hasPages: boolean;
}) {
  const modes: ViewMode[] = [];
  if (hasPages) modes.push("pages");
  if (hasCues) modes.push("text");
  if (hasCustomText) modes.push("custom");
  if (hasCleanText) modes.push("clean");
  modes.push("raw");
  if (hasCleanText) modes.push("split");
  if (hasSourceBlocks) modes.push("blocks");

  if (modes.length <= 1) return null;

  return (
    <div className="flex rounded-md border border-(--border) overflow-hidden text-xs">
      {modes.map((mode) => (
        <button
          key={mode}
          onClick={() => onSetViewMode(mode)}
          data-testid={`view-tab-${mode}`}
          className={`px-2.5 py-1 capitalize ${ viewMode === mode ? "bg-(--accent) text-(--on-accent)" : "bg-(--bg-card) text-(--text-tertiary) hover:bg-(--bg-card-hover)" }`}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

type ChunkRange = { start: number; end: number; url: string };

function TextPreview({
  rawText,
  cleanText,
  customText,
  viewMode,
  chunkRanges,
  selectedChunkUrl,
  onSelectChunk,
  hoveredChunkUrl,
  onHoverChunk,
}: {
  rawText: string;
  cleanText: string | null;
  customText: string | null;
  viewMode: ViewMode;
  chunkRanges: ChunkRange[];
  selectedChunkUrl: string | null;
  onSelectChunk: (url: string) => void;
  hoveredChunkUrl: string | null;
  onHoverChunk: (url: string | null) => void;
}) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  function handleScroll(source: "left" | "right") {
    if (syncing.current) return;
    syncing.current = true;

    const from = source === "left" ? leftRef.current : rightRef.current;
    const to = source === "left" ? rightRef.current : leftRef.current;
    if (from && to) {
      const ratio = from.scrollTop / (from.scrollHeight - from.clientHeight || 1);
      to.scrollTop = ratio * (to.scrollHeight - to.clientHeight || 1);
    }

    requestAnimationFrame(() => { syncing.current = false; });
  }

  const textClass = "mx-auto w-full max-w-prose flex-1 min-h-0 overflow-y-auto rounded bg-(--bg-reading) border border-(--border-reading) px-7 py-6 font-reading text-[17px] text-(--text-primary) whitespace-pre-wrap leading-relaxed";
  
  if (viewMode === "split" && cleanText) {
    return (
      <div className="flex-1 min-h-0 flex gap-3">
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <span className="text-[10px] uppercase tracking-wider text-(--text-faint) mb-1 font-medium shrink-0">Raw</span>
          <div
            ref={leftRef}
            onScroll={() => handleScroll("left")}
            className={textClass}
          >
            {rawText}
          </div>
        </div>
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <span className="text-[10px] uppercase tracking-wider text-(--text-faint) mb-1 font-medium shrink-0">Clean</span>
          <div
            ref={rightRef}
            onScroll={() => handleScroll("right")}
            className={textClass}
          >
            {cleanText}
          </div>
        </div>
      </div>
    );
  }

  if (viewMode === "custom" && customText) {
    return (
      <ChunkedText
        text={customText}
        chunkRanges={chunkRanges}
        selectedChunkUrl={selectedChunkUrl}
        onSelectChunk={onSelectChunk}
        hoveredChunkUrl={hoveredChunkUrl}
        onHoverChunk={onHoverChunk}
        className={textClass + " border-(--border-custom-text) bg-(--bg-custom-text)"}
      />
    );
  }

  const text = viewMode === "clean" && cleanText ? cleanText : rawText;

  return (
    <ChunkedText
      text={text}
      chunkRanges={chunkRanges}
      selectedChunkUrl={selectedChunkUrl}
      onSelectChunk={onSelectChunk}
      hoveredChunkUrl={hoveredChunkUrl}
      onHoverChunk={onHoverChunk}
      className={textClass}
    />
  );
}

function ChunkedText({
  text,
  chunkRanges,
  selectedChunkUrl,
  onSelectChunk,
  hoveredChunkUrl,
  onHoverChunk,
  className,
}: {
  text: string;
  chunkRanges: ChunkRange[];
  selectedChunkUrl: string | null;
  onSelectChunk: (url: string) => void;
  hoveredChunkUrl: string | null;
  onHoverChunk: (url: string | null) => void;
  className: string;
}) {
  const selectedRef = useRef<HTMLElement>(null);

  // Scroll the selected chunk into view whenever the selection changes.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, [selectedChunkUrl]);

  if (chunkRanges.length === 0) {
    return <div className={className}>{text}</div>;
  }

  // Sort by start and drop overlaps so segments tile the text cleanly.
  const ordered = [...chunkRanges].sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let pos = 0;
  ordered.forEach((range, i) => {
    if (range.start < pos) return;
    if (range.start > pos) parts.push(text.slice(pos, range.start));
    const isSelected = range.url === selectedChunkUrl;
    const isHovered = !isSelected && range.url === hoveredChunkUrl;
    parts.push(
      <span
        key={`${range.url}-${i}`}
        ref={isSelected ? selectedRef : undefined}
        onClick={() => onSelectChunk(range.url)}
        onMouseEnter={() => onHoverChunk(range.url)}
        onMouseLeave={() => onHoverChunk(null)}
        className={`cursor-pointer rounded-sm transition-colors ${ isSelected ? "bg-(--bg-selected) text-(--text-primary)" : isHovered ? "bg-(--accent-subtle) text-(--text-primary)" : "" }`}
      >
        {text.slice(range.start, range.end)}
      </span>,
    );
    pos = range.end;
  });
  if (pos < text.length) parts.push(text.slice(pos));

  return <div className={className}>{parts}</div>;
}

function BlocksPreview({ sourceBlocks, onOpenPdf }: { sourceBlocks: SourceBlock[]; onOpenPdf?: (page: number) => void }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto rounded bg-(--bg-subtle) border border-(--border) p-2 font-mono text-xs leading-relaxed">
      {sourceBlocks.map((block, i) => {
        const showPageDivider = i > 0 && block.page !== sourceBlocks[i - 1]?.page;
        return (
          <div key={i}>
            {showPageDivider ? (
              <div className="border-t border-(--divide) my-1.5" />
            ) : null}
            <div className={`flex gap-2 py-0.5 px-1.5 rounded ${block.included ? "" : "opacity-35"}`}>
              {onOpenPdf ? (
                <button
                  onClick={() => onOpenPdf(block.page)}
                  className="text-(--accent-text) hover:text-(--accent-text-hover) tabular-nums shrink-0 w-8 text-right"
                  title="Open the source PDF at this page"
                >
                  {block.page}
                </button>
              ) : (
                <span className="text-(--text-faint) tabular-nums shrink-0 w-8 text-right">{block.page}</span>
              )}
              <span className={`shrink-0 w-24 truncate ${block.included ? "text-(--text-muted)" : "text-(--text-faint) line-through"}`}>
                {block.type}
              </span>
              <span className={`min-w-0 ${block.included ? "text-(--text-secondary)" : "text-(--text-faint)"} truncate`}>
                {block.text}
              </span>
            </div>
          </div>
        );
      })}
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
