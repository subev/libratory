import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router";
import { trpc } from "../trpc.ts";
import { ModelBundleNotice, useModelBundle } from "../components/ModelBundleNotice.tsx";
import { ChapterTable } from "../components/ChapterTable.tsx";
import { Breadcrumbs } from "../components/Breadcrumbs.tsx";
import { SynthesizeModal } from "../components/SynthesizeModal.tsx";
import { StructureModal } from "../components/StructureModal.tsx";
import { VariantModal } from "../components/VariantModal.tsx";
import { BookFilesSection } from "../components/BookFilesSection.tsx";
import { AudioOutputsSection } from "../components/AudioOutputsSection.tsx";
import { DocumentOutputsSection } from "../components/DocumentOutputsSection.tsx";
import { LogDock } from "../components/LogDock.tsx";
import { EditableTitle } from "../components/EditableTitle.tsx";
import { DiskUsageButton } from "../components/DiskUsageButton.tsx";
import { ChapterAiModal, type AiScope } from "../components/ChapterAiModal.tsx";
import { NotesSection } from "../components/NotesSection.tsx";
import { PillToggle } from "../components/PillToggle.tsx";
import { Button } from "../components/Button.tsx";
import { loadBookSort, sortBooks } from "../lib/book-sort.ts";
import { formatBytes, pendingExportLabel, pendingExportSummary } from "../lib/format.ts";
import { getVoiceLabel, languageLabel } from "../lib/voices.ts";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconChat,
  IconStructure,
  IconTranslate,
  IconVolume,
  IconDocument,
} from "../components/icons.tsx";

// A worker killed mid-run (restart, network drop) leaves digestJob stuck on "running"; treat a
// stale heartbeat as interrupted, mirroring the server's resumeDigest guard.
function digestJobLive(digestJob: { status: string; updatedAt: string } | null | undefined): boolean {
  if (digestJob?.status !== "running") return false;
  return Date.now() - new Date(digestJob.updatedAt).getTime() < 15 * 60_000;
}

export function BookDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  // Above the `!book` early return below: hooks after it run only once the book loads, and a
  // render that calls a different number of hooks than the last one takes the page down.
  const { data: renderer } = trpc.renderer.status.useQuery(undefined, { staleTime: Infinity });
  const { ready: extractionReady } = useModelBundle("extraction");
  const installRenderer = trpc.renderer.install.useMutation({ onSuccess: () => void utils.renderer.status.invalidate() });
  const [searchParams, setSearchParams] = useSearchParams();
  const activeVariant = searchParams.get("variant");

  const { data: book, isLoading } = trpc.books.get.useQuery(
    { id: id! },
    {
      enabled: !!id,
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data) return 3000;
        // Raw-only files never get another status change, so poll only briefly after
        // upload — a scanned PDF's rawText stays null forever
        const hasActiveFiles = data.files?.some((f: { status: string; hasRawText?: boolean; createdAt?: string }) =>
          f.status === "extracting" || f.status === "pending" ||
          (f.status === "raw" && !f.hasRawText && Date.now() - new Date(f.createdAt ?? 0).getTime() < 2 * 60_000)
        );
        const hasActiveChapters = data.chapters?.some((c: { status: string }) =>
          ["synthesizing", "normalizing", "pending"].includes(c.status)
        );
        const hasActiveCleanups = data.chapters?.some((c: { cleanup?: { status: string } | null }) =>
          c.cleanup?.status === "cleaning" || c.cleanup?.status === "pending"
        );
        const bookActive = data.status === "extracting" || data.status === "assembling" || data.assembleQueued;
        const proposalRunning = data.chapterProposal?.status === "running";
        const noteJobActive = data.noteJob?.status === "queued" || data.noteJob?.status === "running";
        const digestRunning = data.digestJob?.status === "running";
        return (hasActiveFiles || hasActiveChapters || hasActiveCleanups || bookActive || proposalRunning || noteJobActive || digestRunning) ? 2000 : false;
      },
    }
  );

  const hasChapterAudio = book?.chapters?.some((c: { audioPath?: string | null }) => !!c.audioPath) ?? false;
  // The pages are readable as soon as extraction places a chapter on them — the narration is what
  // gets followed across them later, not what makes them worth opening
  const hasChapterPages = book?.chapters?.some((c: { pageStart?: number | null }) => c.pageStart != null) ?? false;

  const invalidate = () => {
    utils.books.get.invalidate({ id: id! });
    utils.books.assemblies.invalidate({ bookId: id! });
    utils.books.documents.invalidate({ bookId: id! });
    utils.chapters.selectedAudioSize.invalidate({ bookId: id! });
  };

  const { data: bookAssemblies = [] } = trpc.books.assemblies.useQuery(
    { bookId: id! },
    { enabled: !!id },
  );

  const assemblyActive = book ? book.status === "assembling" || book.assembleQueued : undefined;
  const prevAssemblyActive = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (prevAssemblyActive.current === true && assemblyActive === false) {
      utils.books.assemblies.invalidate({ bookId: id! });
      utils.books.documents.invalidate({ bookId: id! });
      utils.books.diskUsage.invalidate({ bookId: id! });
    }
    prevAssemblyActive.current = assemblyActive;
  }, [assemblyActive, id, utils]);

  const { data: originalAudioSize } = trpc.chapters.selectedAudioSize.useQuery(
    { bookId: id! },
    { enabled: !!id && !activeVariant },
  );
  const { data: variantAudioSize } = trpc.variants.selectedAudioSize.useQuery(
    { bookId: id!, key: activeVariant! },
    { enabled: !!id && !!activeVariant },
  );
  const selectedAudioSize = activeVariant ? variantAudioSize : originalAudioSize;

  const { data: bookDocuments = [] } = trpc.books.documents.useQuery(
    { bookId: id! },
    { enabled: !!id, refetchInterval: book?.status === "assembling" ? 2000 : false },
  );

  const { data: pendingExports = [] } = trpc.books.pendingDocumentExports.useQuery(
    { bookId: id! },
    { enabled: !!id, refetchInterval: (query) => (query.state.data?.length ? 2000 : false) },
  );
  const prevPendingCount = useRef(0);
  useEffect(() => {
    if (pendingExports.length < prevPendingCount.current) {
      utils.books.documents.invalidate({ bookId: id! });
      utils.books.diskUsage.invalidate({ bookId: id! });
    }
    prevPendingCount.current = pendingExports.length;
  }, [pendingExports.length, id, utils]);

  // Book mutations
  const cancelMutation = trpc.books.cancel.useMutation({ onSuccess: invalidate });
  const retryMutation = trpc.books.retry.useMutation({ onSuccess: invalidate });
  const redetectMutation = trpc.books.redetectChapters.useMutation({ onSuccess: invalidate });
  const resumeDigestMutation = trpc.books.resumeDigest.useMutation({ onSuccess: invalidate });
  const processSelectedMutation = trpc.books.processSelected.useMutation({ onSuccess: invalidate });
  const deleteMutation = trpc.books.delete.useMutation({
    onSuccess: () => window.location.assign(book?.folderId ? `/folders/${book.folderId}` : "/"),
  });
  const assembleMutation = trpc.books.assemble.useMutation({ onSuccess: invalidate });
  const deleteAssemblyMutation = trpc.books.deleteAssembly.useMutation({ onSuccess: invalidate });
  const exportDocumentMutation = trpc.books.exportDocument.useMutation({
    onSuccess: () => {
      invalidate();
      utils.books.pendingDocumentExports.invalidate({ bookId: id! });
    },
  });
  const deleteDocumentMutation = trpc.books.deleteDocument.useMutation({ onSuccess: invalidate });
  const { data: exportConfig } = trpc.books.exportConfig.useQuery();
  const [copyToImport, setCopyToImport] = useState(true);
  const [waitForAll, setWaitForAll] = useState(true);

  // Chapter mutations
  const queueMutation = trpc.chapters.queue.useMutation({ onSuccess: invalidate });
  const setSelectedMutation = trpc.chapters.setSelected.useMutation({ onSuccess: invalidate });
  const setAllSelectedMutation = trpc.chapters.setAllSelected.useMutation({ onSuccess: invalidate });
  const setSelectedBatchMutation = trpc.chapters.setSelectedBatch.useMutation({ onSuccess: invalidate });

  // File mutations
  const setFileSelectedMutation = trpc.bookFiles.setSelected.useMutation({ onSuccess: invalidate });
  const setAllFilesSelectedMutation = trpc.bookFiles.setAllSelected.useMutation({ onSuccess: invalidate });
  const setFileSelectedBatchMutation = trpc.bookFiles.setSelectedBatch.useMutation({ onSuccess: invalidate });
  const removeFileMutation = trpc.bookFiles.remove.useMutation({ onSuccess: invalidate });
  const reExtractFileMutation = trpc.bookFiles.reExtract.useMutation({ onSuccess: invalidate });
  const reExtractSelectedMutation = trpc.bookFiles.reExtractSelected.useMutation({ onSuccess: invalidate });
  const cancelFileMutation = trpc.bookFiles.cancel.useMutation({ onSuccess: invalidate });

  // Opened from the toolbar and from the raw-text block, so it cannot live in either of them.
  const [extractOpen, setExtractOpen] = useState(false);
  const [showStructure, setShowStructure] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const [showSynthesize, setShowSynthesize] = useState(false);
  const [createTab, setCreateTab] = useState<"audio" | "document">("audio");
  const [askScope, setAskScope] = useState<AiScope | null>(null);
  const setActiveVariant = (key: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (key) next.set("variant", key);
      else next.delete("variant");
      return next;
    }, { replace: true });
  };
  // The request belongs to the lane it was made in, so switching lanes withdraws it
  const [titlesRequestedFor, setTitlesRequestedFor] = useState<string | null | undefined>(undefined);
  const titlesRequested = titlesRequestedFor === activeVariant;

  const { data: variantLanes = [] } = trpc.variants.list.useQuery(
    { bookId: id! },
    { enabled: !!id },
  );
  const activeLane = activeVariant ? variantLanes.find((l) => l.key === activeVariant) ?? null : null;
  const activeLabel = activeVariant ? activeLane?.label ?? activeVariant : null;
  const activeKind = activeLane?.kind ?? "translation";

  // Prev/next navigation follows the home list's persisted sort order, scoped to the book's folder
  const { data: siblingList } = trpc.books.list.useQuery(
    { folderId: book?.folderId ?? null },
    { staleTime: 30_000, enabled: !!book },
  );
  const bookSort = loadBookSort();
  const orderedBooks = siblingList ? sortBooks(siblingList.books, bookSort.key, bookSort.dir) : [];
  const bookIndex = orderedBooks.findIndex((b) => b.id === id);
  const prevBook = bookIndex > 0 ? orderedBooks[bookIndex - 1] : null;
  const nextBook = bookIndex >= 0 && bookIndex < orderedBooks.length - 1 ? orderedBooks[bookIndex + 1] : null;
  const prevBookId = prevBook?.id ?? null;
  const nextBookId = nextBook?.id ?? null;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "[" && e.key !== "]") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (askScope || showStructure || showTranslation || showSynthesize) return;
      const target = e.key === "[" ? prevBookId : nextBookId;
      if (target) navigate(`/books/${target}`);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [prevBookId, nextBookId, navigate, askScope, showStructure, showTranslation, showSynthesize]);

  const { data: translationRows = [] } = trpc.variants.listForBook.useQuery(
    { bookId: id!, key: activeVariant! },
    {
      enabled: !!id && !!activeVariant,
      refetchInterval: (query) => {
        const active = query.state.data?.some((t) =>
          t.status === "translating" || t.status === "pending" ||
          t.audioStatus === "synthesizing" || t.audioStatus === "pending"
        );
        const titlesPending = titlesRequested &&
          query.state.data?.some((t) => t.status === "done" && !t.title);
        return active || titlesPending ? 2000 : false;
      },
    },
  );

  const invalidateVariants = () => {
    utils.variants.listForBook.invalidate();
    utils.variants.list.invalidate();
    utils.books.assemblies.invalidate({ bookId: id! });
    utils.books.documents.invalidate({ bookId: id! });
    utils.books.logs.invalidate({ bookId: id! });
  };
  const queueAudioMutation = trpc.variants.queueAudio.useMutation({ onSuccess: invalidateVariants });
  const processSelectedVariantsMutation = trpc.variants.processSelected.useMutation({ onSuccess: invalidateVariants });
  const processSelectedAudioMutation = trpc.variants.processSelectedAudio.useMutation({ onSuccess: invalidateVariants });
  const stopAudioMutation = trpc.variants.stopAudio.useMutation({ onSuccess: invalidateVariants });
  const translateTitlesMutation = trpc.variants.translateMissingTitles.useMutation({
    onSuccess: () => {
      setTitlesRequestedFor(activeVariant);
      invalidateVariants();
    },
  });
  const assembleVariantMutation = trpc.variants.assemble.useMutation({ onSuccess: invalidateVariants });
  const renameMutation = trpc.books.rename.useMutation({ onSuccess: invalidate });
  const updateSettingsMutation = trpc.books.updateSettings.useMutation({ onSuccess: invalidate });
  const setAutoSynthesizeMutation = trpc.books.setAutoSynthesize.useMutation();
  const setVariantVoiceMutation = trpc.variants.setVoice.useMutation({ onSuccess: invalidate });
  const deleteChaptersMutation = trpc.chapters.deleteSelected.useMutation({ onSuccess: invalidate });
  const invalidateAudioSizes = () => {
    utils.books.diskUsage.invalidate({ bookId: id! });
    utils.chapters.selectedAudioSize.invalidate({ bookId: id! });
    utils.variants.selectedAudioSize.invalidate();
  };
  const deleteAudioMutation = trpc.chapters.deleteAudioSelected.useMutation({
    onSuccess: () => {
      invalidate();
      invalidateAudioSizes();
    },
  });
  const deleteVariantAudioMutation = trpc.variants.deleteAudioSelected.useMutation({
    onSuccess: () => {
      utils.variants.listForBook.invalidate();
      utils.variants.list.invalidate();
      invalidateAudioSizes();
    },
  });
  const cleanupSelectedMutation = trpc.chapters.cleanupSelected.useMutation({ onSuccess: invalidate });
  const renameChapterMutation = trpc.chapters.rename.useMutation({ onSuccess: invalidate });
  const reorderChaptersMutation = trpc.chapters.reorder.useMutation({ onSuccess: invalidate });

  if (isLoading || !book) {
    return (
      <div className="min-h-screen bg-(--bg-page)">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <p className="text-(--text-muted)">Loading...</p>
        </div>
      </div>
    );
  }

  // Derived state
  const hasActiveFiles = book.files?.some((f) => f.status === "extracting" || f.status === "pending") ?? false;
  const hasRawText = book.files?.some((f) => f.hasRawText) ?? false;
  const isAssembling = book.status === "assembling";
  const isSynthetic = book.kind !== "pdf";
  const digestLive = digestJobLive(book.digestJob);
  const digestFailed = book.digestJob?.status === "failed";
  const digestTotal = book.origin?.type === "digest" ? book.origin.sourceBookIds.length : 0;
  const digestIncomplete = digestTotal > 0 && book.chapters.length < digestTotal && !digestLive;

  // Translation view: replace every chapter row with its <activeVariant> counterpart — no fallback to the original
  const translationByChapter = new Map(translationRows.map((t) => [t.chapterId, t]));
  const viewChapters = !activeVariant
    ? book.chapters
    : book.chapters.map((c) => {
        const t = translationByChapter.get(c.id);
        const translated = t?.status === "done";
        return {
          ...c,
          title: t?.title ?? c.title,
          // null audioStatus = never queued; "suspended" is this app's idle-awaiting-action state
          status: translated
            ? (t.audioStatus ?? "suspended")
            : t?.status === "translating" || t?.status === "pending"
              ? (activeKind === "translation" ? "translating" : "rewriting")
              : (activeKind === "translation" ? "untranslated" : "missing"),
          wordCount: t ? t.wordCount : 0,
          durationMs: translated ? t.audioDurationMs : null,
          audioPath: translated && t.hasAudio ? "translated" : null,
          progress: translated ? t.audioProgress : t?.progress ?? null,
          error: translated ? t.audioError : t?.error ?? null,
          synthesizable: translated,
          hasCustomText: false,
          hasCleanText: false,
          hasSourceBlocks: false,
          synthesizedWith: null,
          audioUrl: t && translated ? `/audio/translation/${t.id}?v=${new Date(t.updatedAt).getTime()}` : undefined,
        };
      });

  const selectedCount = viewChapters.filter((c) => c.selected).length;
  const hasActiveChapters = viewChapters.some((c) =>
    ["synthesizing", "normalizing", "pending"].includes(c.status)
  );
  const isProcessing = hasActiveFiles || hasActiveChapters ||
    book.status === "extracting" || book.status === "assembling";
  const selectedWithAudio = viewChapters.filter((c) => c.selected && c.status === "done" && c.audioPath).length;
  // Server-measured (chapter audio + chunk WAVs on disk); client estimate covers the query's loading gap
  const audioDataCount = selectedAudioSize?.count ??
    viewChapters.filter((c) => c.selected && (c.audioPath || c.progress)).length;
  const audioDataSize = formatBytes(selectedAudioSize?.bytes ?? 0);
  // In a language view a still-translating chapter counts too: its audio queues behind the translation
  const selectedSynthesizable = viewChapters.filter((c) => {
    if (!c.selected) return false;
    if (["failed", "suspended", "pending", "done"].includes(c.status)) return true;
    const t = activeVariant ? translationByChapter.get(c.id) : undefined;
    return t?.status === "translating" || t?.status === "pending";
  }).length;
  const allSelectedDone = selectedCount > 0 && viewChapters.filter((c) => c.selected).every((c) => c.status === "done" && c.audioPath);
  // Outputs that need audio can be queued behind the chapters still producing it
  const selectedInFlight = viewChapters.filter((c) =>
    c.selected && ["pending", "normalizing", "synthesizing"].includes(c.status)
  ).length;
  const deferOutputs = waitForAll && selectedInFlight > 0;
  const canAssemble = (allSelectedDone || deferOutputs) && !isAssembling;
  // Language-view audio queueing is idempotent server-side, so running chapters don't block it
  const canProcess = selectedSynthesizable > 0 && !isAssembling && (!!activeVariant || !hasActiveChapters);
  const translationsRunning = activeVariant
    ? translationRows.some((t) => t.status === "translating" || t.status === "pending")
    : false;
  // Covers audio queued behind a running translation, which the row mapping shows as "untranslated"
  const translationAudioQueued = activeVariant
    ? translationRows.some((t) => t.audioStatus === "pending" || t.audioStatus === "synthesizing")
    : false;
  const missingTitleCount = activeVariant && activeKind === "translation"
    ? translationRows.filter((t) => t.status === "done" && !t.title).length
    : 0;
  const selectedTranslatable = activeVariant
    ? book.chapters.filter((c) => {
        if (!c.selected) return false;
        const t = translationByChapter.get(c.id);
        return !t || t.status === "failed" || t.status === "suspended";
      }).length
    : 0;
  const selectedCleanable = activeVariant
    ? 0
    : book.chapters.filter((c) => {
        if (!c.selected) return false;
        const s = c.cleanup?.status;
        return s !== "done" && s !== "cleaning" && s !== "pending";
      }).length;
  // Document export needs text, not audio: original chapters always have it, language views need a finished translation
  const selectedExportable = activeVariant
    ? book.chapters.filter((c) => c.selected && translationByChapter.get(c.id)?.status === "done").length
    : selectedCount;
  // Synced EPUB embeds the narration, so it needs finished audio, not just text
  const selectedSyncExportable = activeVariant
    ? book.chapters.filter((c) => c.selected && translationByChapter.get(c.id)?.audioStatus === "done").length
    : selectedWithAudio;
  const viewPendingExports = pendingExports.filter((e) => (e.language ?? null) === activeVariant);
  const pendingExportFor = (format: "pdf" | "epub" | "epub-sync") => viewPendingExports.find((e) => e.format === format);
  const rendererReady = renderer?.installed !== false;
  const canExportDocument = selectedExportable > 0 && !isAssembling && !exportDocumentMutation.isPending && rendererReady;
  const canExportSync = (selectedSyncExportable > 0 || deferOutputs) && !isAssembling && !exportDocumentMutation.isPending;
  const exportTooltip = (format: "pdf" | "epub") =>
    !rendererReady ? "PDF and EPUB need a page renderer — download it once, below"
      : pendingExportFor(format)?.running ? `${format.toUpperCase()} export is rendering`
      : pendingExportFor(format) ? `${format.toUpperCase()} export ${pendingExportLabel(pendingExportFor(format)!)} — click again to replace it`
      : selectedExportable === 0
      ? (activeVariant ? `No selected chapters have finished ${activeLabel} text` : "No chapters selected")
      : isAssembling ? "Wait for the current assembly to finish"
      : `Render the selected chapters as ${format === "pdf" ? "a PDF" : "an EPUB"} book`;
  const pendingSync = pendingExportFor("epub-sync");
  const syncExportTooltip =
    pendingSync?.running ? "Synced EPUB export is rendering"
      : pendingSync ? `Synced EPUB export ${pendingExportLabel(pendingSync)}${pendingSync.copyToDropDir ? ", will copy to the import folder" : ", will NOT copy to the import folder"} — click again to replace it with the settings above`
      : deferOutputs
      ? `Queue the export now — it runs once the ${selectedInFlight} chapter(s) still synthesizing are finished`
      : selectedSyncExportable === 0
      ? `No selected chapters have finished${activeVariant ? ` ${activeLabel}` : ""} audio`
      : isAssembling ? "Wait for the current assembly to finish"
      : "EPUB with read-along narration — audio plus highlighted text, for Storyteller and other readers that support EPUB media overlays";

  const langSuffix = activeVariant ? ` · ${activeLabel}` : "";

  return (
    <div className="min-h-screen bg-(--bg-page)">
      <div className="max-w-6xl mx-auto px-4 py-8 pb-20">
        <div className="flex items-center justify-between mb-4">
          <Breadcrumbs
            items={[
              { to: "/", label: "Home" },
              ...(book.folderPath ?? []).map((f) => ({ to: `/folders/${f.id}`, label: f.name })),
            ]}
          />
          <div className="flex items-center gap-2" data-testid="book-nav">
            <Button
              variant="primary"
              soft
              size="sm"
              onClick={() => prevBook && navigate(`/books/${prevBook.id}`)}
              disabled={!prevBook}
              title={prevBook ? `Previous book: "${prevBook.title}" — press [` : "This is the first book in the list"}
              data-testid="prev-book"
              >
              <IconArrowLeft className="h-4 w-4" />
              Prev
            </Button>
            {bookIndex >= 0 && (
              <span className="text-xs text-(--text-faint) tabular-nums" title={`Position in the home list's current sort (${bookSort.key})`}>
                {bookIndex + 1} of {orderedBooks.length}
              </span>
            )}
            <Button
              variant="primary"
              soft
              size="sm"
              onClick={() => nextBook && navigate(`/books/${nextBook.id}`)}
              disabled={!nextBook}
              title={nextBook ? `Next book: "${nextBook.title}" — press ]` : "This is the last book in the list"}
              data-testid="next-book"
              >
              Next
              <IconArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
             <EditableTitle
               title={book.title}
               onRename={(title) => renameMutation.mutate({ id: book.id, title })}
             />
             <p className="text-sm text-(--text-muted) mt-1 flex items-center gap-2">
               <EditableTitle
                 title={book.author ?? ""}
                 placeholder="Add an author"
                 className="text-sm text-(--text-muted)"
                 hint="Who wrote it — travels with the book when it is exported"
                 onRename={(author) => updateSettingsMutation.mutate({ id: book.id, author })}
               />
               ·
               {book.language ? (
                 <span title="The language this book is written in — change it in Extract...">
                   {languageLabel(book.language)}
                 </span>
               ) : (
                 <span className="text-(--text-faint)" title="Set it in Extract... to get matching voices offered first">
                   Language not set
                 </span>
               )}
               {book.skipSynthesis && <span>· Reader mode</span>}
             </p>
           </div>
          <div className="shrink-0 pt-1 flex items-center gap-2">
            <Button
              variant="secondary"
              to={`/books/${book.id}/read`}
              disabled={!(hasChapterAudio || hasChapterPages)}
              title={
                !(hasChapterAudio || hasChapterPages)
                  ? "No chapter is on a page yet — extract chapters to read this book on its own print"
                  : hasChapterAudio
                    ? "Follow the narration on the PDF page, and tap a sentence to jump there"
                    : "Read the book's own pages — synthesize a chapter to follow the narration across them"
              }
              data-testid="book-read-link"
            >
              <IconBook className="h-4 w-4" />
              Read along
            </Button>
            <Button
              variant="secondary"
              to={`/chat?bookId=${book.id}`}
              title="Chat about this book — searches its text and translations, cites pages"
              data-testid="book-chat-link"
            >
              <IconChat className="h-4 w-4" />
              Chat
            </Button>
            <DiskUsageButton bookId={book.id} />
          </div>
        </div>

        {/* Starting an extraction can be refused before any job exists — no files selected, or
            chapters mid-synthesis — and none of these mutations renders its own error. */}
        {(() => {
          const refusal = setAutoSynthesizeMutation.error ?? reExtractSelectedMutation.error ?? retryMutation.error ?? redetectMutation.error;
          return refusal ? (
            <div className="bg-(--danger-bg) border border-(--danger) rounded-lg p-3 mb-4" data-testid="extract-start-error">
              <p className="text-sm text-(--danger-text)">Could not start: {refusal.message}</p>
            </div>
          ) : null;
        })()}

        {/* "All 1 file(s) failed extraction" only counts what the rows below already say, and says
            it louder than the reason. Matching that one sentence rather than "some file failed":
            "No chapters detected in any file" is also set by the extract worker, and assembly,
            re-detection and export write here too — none of them has a row to appear in. */}
        {book.error && !/^All \d+ file\(s\) failed extraction$/.test(book.error) && (
          <div className="bg-(--danger-bg) border border-(--danger) rounded-lg p-3 mb-4">
            <p className="text-sm text-(--danger-text) font-mono">{book.error}</p>
          </div>
        )}

        {/* STAGE 1: Input — source files & extraction */}
        <BookFilesSection
          files={book.files ?? []}
          chapters={book.chapters}
          bookId={book.id}
          isProcessing={isProcessing}
          forceOcr={book.forceOcr}
          llmChapterDetection={book.llmChapterDetection}
          chapterModel={book.chapterModel ?? null}
          language={book.language ?? null}
          onUpdateExtractionSettings={(settings) => updateSettingsMutation.mutate({ id: book.id, ...settings })}
          onSetSelected={(fid, selected) => setFileSelectedMutation.mutate({ id: fid, selected })}
          onSetAllSelected={(selected) => setAllFilesSelectedMutation.mutate({ bookId: book.id, selected })}
          onSetSelectedBatch={(ids, selected) => setFileSelectedBatchMutation.mutate({ ids, selected })}
          onRemove={(fid) => removeFileMutation.mutate({ id: fid })}
          onReExtract={(fid) => reExtractFileMutation.mutate({ id: fid })}
          voiceLabel={getVoiceLabel(book.voice)}
          extractOpen={extractOpen}
          onExtractOpenChange={setExtractOpen}
          onStartExtraction={async (scope, autoSynthesize) => {
            for (const m of [setAutoSynthesizeMutation, reExtractSelectedMutation, retryMutation, redetectMutation]) m.reset();
            try {
              // Starting with the previous follow-on setting is worse than not starting: it decides
              // whether hours of synthesis begin on their own when this finishes.
              await setAutoSynthesizeMutation.mutateAsync({ id: book.id, autoSynthesize });
            } catch {
              return; // The banner is already showing it
            }
            if (scope === "selected") reExtractSelectedMutation.mutate({ bookId: book.id });
            else if (scope === "book") retryMutation.mutate({ id: book.id });
            else redetectMutation.mutate({ id: book.id });
          }}
          onCancelExtraction={() => {
            if (confirm("Stop the running extraction? Files already extracted are kept.")) {
              cancelMutation.mutate({ id: book.id });
            }
          }}
          onCancel={(fid) => cancelFileMutation.mutate({ id: fid })}
          onFilesAdded={invalidate}
        />

        {/* STAGE 2: Work — chapter structure, text, translation */}
        <section className="mb-6 rounded-xl border border-(--border) border-t-2 border-t-(--step-work)/80 bg-(--bg-card) p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-(--text-secondary)">
                <span className="text-xs font-medium text-(--accent-text) uppercase tracking-wider mr-2">2 · Work</span>
                Chapters
              </h2>
              {book.chapterDetection && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full bg-(--bg-subtle) text-(--text-muted)"
                  title={{
                    "llm": "Boundaries picked by AI from the table of contents",
                    "numbered-headings": "Numbered chapter headings (Chapter N) found in the document",
                    "heading-levels": "Split at the most plausible heading level",
                    "word-split": "No usable headings — split every ~5000 words",
                    "manual": "Boundaries chosen by hand in the structure view",
                  }[book.chapterDetection]}
                >
                  {{
                    "llm": "LLM · ToC-matched",
                    "numbered-headings": "Chapter numbering",
                    "heading-levels": "Heading heuristic",
                    "word-split": "Word-count split",
                    "manual": "Manual boundaries",
                  }[book.chapterDetection]}
                </span>
              )}
            </div>
            {book.chapters.length > 0 && (
              <span className="text-sm text-(--text-muted)">
                {selectedCount} of {book.chapters.length} selected
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Button
              variant="secondary"
              onClick={() => setShowStructure(true)}
              disabled={book.kind !== "pdf"}
              title={book.kind !== "pdf" ? "Synthetic book — no PDF structure to edit" : "Review every detected heading and edit chapter boundaries by hand"}
              data-testid="open-structure"
            >
              <IconStructure className="w-4 h-4 text-(--accent-text)" />
              Structure
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowTranslation(true)}
              disabled={book.chapters.length === 0}
              title={book.chapters.length === 0 ? "Extract chapters first" : "Translate or rewrite chapters (ELI5, summary, custom prompts) and review side by side"}
              data-testid="open-translation"
            >
              <IconTranslate className="w-4 h-4 text-(--accent-text)" />
              Translate / Transform
            </Button>

            {/* Variant view switcher */}
            {variantLanes.length > 0 && (
              <div className="flex items-center gap-2 ml-auto" data-testid="language-switcher">
                <PillToggle
                  selected={!activeVariant}
                  onClick={() => setActiveVariant(null)}
                  title={
                    book.language
                      ? `The book's own text (${book.language.toUpperCase()}) — change the language in Re-extract...`
                      : "The book's own text — set its language in Re-extract... to get matching voices"
                  }
                >
                  Original
                  {book.language && (
                    <span className={`ml-1.5 ${!activeVariant ? "text-(--on-accent)/70" : "text-(--text-faint)"}`}>
                      {book.language.toUpperCase()}
                    </span>
                  )}
                </PillToggle>
                {variantLanes.map((l) => (
                  <PillToggle
                    key={l.key}
                    selected={activeVariant === l.key}
                    onClick={() => setActiveVariant(l.key)}
                    title={`${l.done} of ${book.chapters.length} chapters ${l.kind === "translation" ? "translated" : "rewritten"}`}
                  >
                    {l.label ?? l.key} ({l.done}/{book.chapters.length})
                  </PillToggle>
                ))}
              </div>
            )}
          </div>

          {activeVariant && (
            <div
              className="flex items-center gap-2 mb-3 px-4 py-2.5 rounded-lg bg-(--accent-subtle) border border-(--accent) text-sm text-(--text-primary)"
              data-testid="translation-view-banner"
            >
              <span className="font-semibold">{activeLabel} {activeKind === "translation" ? "translation" : "rewrite"} view</span>
              <span className="text-(--text-secondary)">
                — text, audio, and assemblies below are the {activeLabel} version. Select chapters to generate or synthesize them in bulk.
                {translationsRunning ? (activeKind === "translation" ? " Translation in progress..." : " Rewrite in progress...") : ""}
              </span>
              <div className="flex-1" />
              {missingTitleCount > 0 ? (
                <button
                  onClick={() => translateTitlesMutation.mutate({ bookId: book.id, key: activeVariant })}
                  disabled={translateTitlesMutation.isPending || titlesRequested}
                  title={`Translate the ${missingTitleCount} chapter title${missingTitleCount === 1 ? "" : "s"} still shown in the original language`}
                  className="text-xs font-medium text-(--accent-text) hover:underline shrink-0 disabled:opacity-50 disabled:no-underline"
                  data-testid="translate-titles"
                >
                  {titlesRequested ? `Translating titles (${missingTitleCount} left)...` : `Translate titles (${missingTitleCount})`}
                </button>
              ) : null}
              <button
                onClick={() => setActiveVariant(null)}
                className="text-xs font-medium text-(--accent-text) hover:underline shrink-0"
              >
                Back to original
              </button>
            </div>
          )}

          {/* Chapter work toolbar — acts on the selected chapters */}
          {book.chapters.length > 0 && (
            <div className="flex gap-3 mb-3 flex-wrap">
              <Button
                variant="primary"
                onClick={() => setShowSynthesize(true)}
                disabled={selectedSynthesizable === 0}
                title={
                  selectedSynthesizable === 0
                    ? (activeVariant ? `No selected chapters have ${activeLabel} text ready or underway` : "No selected chapters are ready for synthesis")
                    : "Pick voice and speed, then synthesize the selected chapters"
                }
                data-testid="open-synthesize"
              >
                Synthesize selected ({selectedSynthesizable}){langSuffix}...
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  activeVariant
                    ? stopAudioMutation.mutate({ bookId: book.id, key: activeVariant })
                    : cancelMutation.mutate({ id: book.id })
                }
                disabled={!(hasActiveChapters || translationAudioQueued) || cancelMutation.isPending || stopAudioMutation.isPending}
                title={!(hasActiveChapters || translationAudioQueued) ? "No chapters are actively processing" : "Stop the running synthesis — finished chapters keep their audio, the rest resume later"}
                data-testid="cancel-processing"
              >
                Cancel processing
              </Button>
              <Button
                variant="secondary"
                onClick={() => processSelectedVariantsMutation.mutate({ bookId: book.id, key: activeVariant! })}
                disabled={!activeVariant || selectedTranslatable === 0 || processSelectedVariantsMutation.isPending}
                title={
                  !activeVariant ? "Open a variant view to run it on the selected chapters" :
                  selectedTranslatable === 0 ? "No selected chapters need this — finished ones are skipped" :
                  activeKind === "translation"
                    ? `Translate the selected chapters to ${activeLabel} (finished ones are skipped, stopped ones resume)`
                    : `Rewrite the selected chapters as ${activeLabel} (finished ones are skipped, stopped ones resume)`
                }
                data-testid="translate-selected"
              >
                {activeKind === "translation" ? "Translate" : "Rewrite"} selected ({selectedTranslatable}){langSuffix}
              </Button>
              <Button
                variant="secondary"
                onClick={() => cleanupSelectedMutation.mutate({ bookId: book.id })}
                disabled={!!activeVariant || selectedCleanable === 0 || cleanupSelectedMutation.isPending}
                title={
                  activeVariant ? "Switch to the Original view — cleanup runs on the original text" :
                  selectedCleanable === 0 ? "No selected chapters need cleanup — already-cleaned and running ones are skipped" :
                  "Ask AI to strip OCR artifacts from the selected chapters without altering the prose (cleaned ones are skipped)"
                }
                data-testid="cleanup-selected"
              >
                Cleanup selected ({selectedCleanable})
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  const selected = book.chapters.filter((c) => c.selected).map((c) => ({ id: c.id, title: c.title }));
                  setAskScope(
                    selected.length > 0 && !activeVariant
                      ? { kind: "chapters", bookId: book.id, chapters: selected }
                      : { kind: "book-raw", bookId: book.id, bookTitle: book.title, chapters: selected },
                  );
                }}
                disabled={book.rawTextTotalWords === 0 && (selectedCount === 0 || !!activeVariant)}
                title={
                  book.rawTextTotalWords === 0 && selectedCount === 0
                    ? "No raw text or chapters to ask about"
                    : "Summarize, question, or run any prompt — switch between selected chapters and the whole book inside"
                }
                data-testid="ask-ai-selected"
              >
                Ask AI
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(`Delete ${selectedCount} selected chapter(s) and their audio?`)) {
                    deleteChaptersMutation.mutate({ bookId: book.id });
                  }
                }}
                disabled={selectedCount === 0 || hasActiveChapters || !!activeVariant || deleteChaptersMutation.isPending}
                title={
                  activeVariant ? "Switch to the Original view to delete chapters" :
                  selectedCount === 0 ? "No chapters selected" :
                  hasActiveChapters ? "Wait for active chapters to finish" :
                  "Delete selected chapters and their audio"
                }
              >
                Delete selected ({selectedCount})
              </Button>
            </div>
          )}

          {book.chapters.length === 0 ? (
            isSynthetic ? (
              <div className="rounded-lg border border-(--border) bg-(--bg-subtle) p-4 space-y-3" data-testid="digest-block">
                {digestLive ? (
                  <div className="flex items-center gap-2 text-sm text-(--text-secondary)">
                    <span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse" />
                    Generating digest — {book.digestJob?.progress ? `${book.digestJob.progress} books` : "starting"}... chapters appear as summaries finish.
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-(--text-secondary)">
                      {digestFailed
                        ? `Digest failed: ${book.digestJob?.error ?? "unknown error"}`
                        : "No chapters were generated."}
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() => resumeDigestMutation.mutate({ id: book.id })}
                      disabled={resumeDigestMutation.isPending}
                      title="Re-run the digest — books that already have a summary chapter are skipped"
                      data-testid="resume-digest"
                    >
                      {resumeDigestMutation.isPending ? "Queuing..." : "Resume digest"}
                    </Button>
                    {resumeDigestMutation.error && (
                      <p className="text-(--danger-text) text-sm">{resumeDigestMutation.error.message}</p>
                    )}
                  </>
                )}
              </div>
            ) : book.status === "extracting" || hasActiveFiles ? (
              <p className="text-(--text-muted) text-sm">Extracting chapters from PDF...</p>
            ) : (
              <div className="rounded-lg border border-(--border) bg-(--bg-subtle) p-4 space-y-3" data-testid="raw-book-block">
                <p className="text-sm text-(--text-secondary)">
                  {hasRawText
                    ? `Raw text extracted — ${book.rawTextTotalWords.toLocaleString()} words across ${book.files?.length ?? 0} file${(book.files?.length ?? 0) === 1 ? "" : "s"}. Ask AI about the whole book right away, or extract chapters to structure, translate, and listen.`
                    : "No chapters extracted yet, and no raw text is available — the PDF may be scanned or encrypted."}
                </p>
                <div className="flex gap-3 flex-wrap">
                  <Button
                    variant="primary"
                    onClick={() => setExtractOpen(true)}
                    disabled={!extractionReady}
                    title={extractionReady
                      ? "Choose what to read and with which settings, then start — Marker takes minutes per book"
                      : "Full extraction needs the Marker models — download them below"}
                    data-testid="extract-chapters"
                  >
                    Extract chapters...
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setAskScope({ kind: "book-raw", bookId: book.id, bookTitle: book.title })}
                    disabled={!hasRawText}
                    title={
                      hasRawText
                        ? "Summarize, question, or run any prompt against the whole book's raw text"
                        : "No raw text — the PDF may be scanned; run Extract chapters with Force OCR instead"
                    }
                    data-testid="ask-ai-book"
                  >
                    Ask AI (whole book)
                  </Button>
                </div>
                <ModelBundleNotice id="extraction" verb="Extracting chapters" />
              </div>
            )
          ) : (
            <>
            {isSynthetic && digestLive && (
              <div className="flex items-center gap-2 text-sm text-(--text-muted) mb-2" data-testid="digest-progress">
                <span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse" />
                Generating digest — {book.digestJob?.progress ? `${book.digestJob.progress} books` : "starting"}...
              </div>
            )}
            {isSynthetic && (digestFailed || digestIncomplete) && (
              <div className="flex items-center gap-3 text-sm mb-2" data-testid="digest-partial-failed">
                <span className="text-(--danger-text)">
                  {digestFailed
                    ? `Digest incomplete: ${book.digestJob?.error ?? "some sources failed"}`
                    : `Digest interrupted — ${book.chapters.length} of ${digestTotal} books summarized`}
                </span>
                <button
                  onClick={() => resumeDigestMutation.mutate({ id: book.id })}
                  disabled={resumeDigestMutation.isPending}
                  title="Re-run the digest — books that already have a summary chapter are skipped"
                  className="text-(--accent-text) hover:underline font-medium disabled:opacity-50"
                >
                  Resume
                </button>
              </div>
            )}
            <ChapterTable
          language={book.language ?? null}
              bookId={book.id}
              chapters={viewChapters}
              files={book.files?.map((f) => ({ id: f.id, index: f.index, filename: f.filename }))}
              onQueue={(cid, resume) =>
                activeVariant
                  ? queueAudioMutation.mutate({ chapterId: cid, key: activeVariant, resume })
                  : queueMutation.mutate({ id: cid, resume })
              }
              onRename={activeVariant ? undefined : (cid, title) => renameChapterMutation.mutate({ id: cid, title })}
              onReorder={activeVariant ? undefined : (chapterIds) => reorderChaptersMutation.mutate({ bookId: book.id, chapterIds })}
              onSetSelected={(cid, selected) => setSelectedMutation.mutate({ id: cid, selected })}
              onSetAllSelected={(selected) => setAllSelectedMutation.mutate({ bookId: book.id, selected })}
              onSetSelectedBatch={(ids, selected) => setSelectedBatchMutation.mutate({ ids, selected })}
              variant={activeLane ?? (activeVariant ? { key: activeVariant, kind: "translation" as const, label: null } : null)}
              variants={variantLanes.map((l) => ({ key: l.key, label: l.label, kind: l.kind }))}
              onSwitchVariant={setActiveVariant}
              synthVoice={(activeVariant && book.variantVoices?.[activeVariant]?.voice) || book.voice}
              onChangeSynthVoice={(voice) =>
                activeVariant
                  ? setVariantVoiceMutation.mutate({ bookId: book.id, key: activeVariant, voice })
                  : updateSettingsMutation.mutate({ id: book.id, voice })
              }
            />
            </>
          )}

          {/* Create outputs from the selected chapters */}
          {book.chapters.length > 0 && (
            <div className="mt-4">
              <div className="inline-flex rounded-lg bg-(--bg-subtle) border border-(--border) p-1 gap-1">
                {/* button-ok: a tab in a segmented control — picking which panel shows, not an action */}
                <button
                  onClick={() => setCreateTab("audio")}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    createTab === "audio"
                      ? "bg-(--bg-card) shadow-sm text-(--accent-text)"
                      : "text-(--text-muted) hover:text-(--text-secondary)"
                  }`}
                  data-testid="create-tab-audio"
                >
                  <IconVolume className="w-4 h-4" />
                  Create audio
                  {(hasActiveChapters || translationAudioQueued) && (
                    <span className="w-1.5 h-1.5 rounded-full bg-(--accent) animate-pulse" title="Synthesis in progress" />
                  )}
                </button>
                {/* button-ok: a tab in a segmented control — picking which panel shows, not an action */}
                <button
                  onClick={() => setCreateTab("document")}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    createTab === "document"
                      ? "bg-(--bg-card) shadow-sm text-(--accent-text)"
                      : "text-(--text-muted) hover:text-(--text-secondary)"
                  }`}
                  data-testid="create-tab-document"
                >
                  <IconDocument className="w-4 h-4" />
                  Create document
                  {viewPendingExports.length > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-(--accent) animate-pulse" title="Export in progress" />
                  )}
                </button>
              </div>
              {selectedInFlight > 0 && (
                <div className="pt-3 flex items-center gap-2 flex-wrap" data-testid="output-timing">
                  <span className="text-xs text-(--text-muted)">
                    {selectedInFlight} of {selectedCount} selected chapter{selectedCount === 1 ? "" : "s"} still synthesizing —
                  </span>
                  <div className="inline-flex rounded-lg bg-(--bg-subtle) border border-(--border) p-0.5 gap-0.5">
                    {/* button-ok: one side of a segmented choice, not an action — the build runs from the button below */}
                    <button
                      onClick={() => setWaitForAll(false)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        waitForAll ? "text-(--text-muted) hover:text-(--text-secondary)" : "bg-(--bg-card) shadow-sm text-(--text-primary)"
                      }`}
                      title="Build straight away from the chapters that already have audio"
                      data-testid="output-timing-now"
                    >
                      Ready now ({selectedWithAudio})
                    </button>
                    {/* button-ok: one side of a segmented choice, not an action — the build runs from the button below */}
                    <button
                      onClick={() => setWaitForAll(true)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        waitForAll ? "bg-(--bg-card) shadow-sm text-(--text-primary)" : "text-(--text-muted) hover:text-(--text-secondary)"
                      }`}
                      title="Queue the job now — it runs by itself once no chapter is still synthesizing"
                      data-testid="output-timing-wait"
                    >
                      When all {selectedCount} finish
                    </button>
                  </div>
                </div>
              )}
              <div className={`pt-3 space-y-3 ${createTab === "audio" ? "" : "hidden"}`}>
                <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="primary"
                  onClick={() =>
                    activeVariant
                      ? assembleVariantMutation.mutate({ bookId: book.id, key: activeVariant, waitForAll: deferOutputs })
                      : assembleMutation.mutate({ id: book.id, waitForAll: deferOutputs })
                  }
                  disabled={!canAssemble || assembleMutation.isPending || assembleVariantMutation.isPending}
                  title={
                    selectedCount === 0 ? "No chapters selected" :
                    deferOutputs ? `Queue the assembly now — it runs once the ${selectedInFlight} chapter(s) still synthesizing are finished` :
                    !allSelectedDone ? "All selected chapters must be done with audio" :
                    isAssembling ? "Assembly already in progress" :
                    undefined
                  }
                  data-testid="assemble-button"
                >
                  {book.outputPath ? "Re-assemble" : "Assemble"}{deferOutputs ? " when ready" : " selected"} ({deferOutputs ? selectedCount : selectedWithAudio}){langSuffix}
                </Button>
                <Button
                  variant="danger"
                  soft
                  onClick={() => {
                    if (confirm(`Delete the synthesized${activeVariant ? ` ${activeLabel}` : ""} audio files and WAV chunks of ${audioDataCount} selected chapter(s), freeing ${audioDataSize}? ${activeVariant ? "Variant text" : "Chapters and text"} are kept — you can re-synthesize anytime.`)) {
                      if (activeVariant) {
                        deleteVariantAudioMutation.mutate({ bookId: book.id, key: activeVariant });
                      } else {
                        deleteAudioMutation.mutate({ bookId: book.id });
                      }
                    }
                  }}
                  disabled={audioDataCount === 0 || hasActiveChapters || deleteAudioMutation.isPending || deleteVariantAudioMutation.isPending}
                  title={
                    audioDataCount === 0 ? "No selected chapters have synthesized audio on disk" :
                    hasActiveChapters ? "Wait for active chapters to finish" :
                    `Delete the synthesized${activeVariant ? ` ${activeLabel}` : ""} audio files and WAV chunks of the selected chapters (${audioDataSize}) — text is kept, re-synthesize anytime`
                  }
                  data-testid="delete-audio-selected"
                >
                  Delete chapter audio ({audioDataCount}{selectedAudioSize && selectedAudioSize.bytes > 0 ? ` · ${audioDataSize}` : ""}){langSuffix}
                </Button>
                </div>
              </div>
              <div className={`pt-3 ${createTab === "document" ? "" : "hidden"}`}>
                <div className="flex items-start gap-2 flex-wrap">
                  <Button
                    variant="secondary"
                    onClick={() => exportDocumentMutation.mutate({ id: book.id, language: activeVariant ?? undefined, format: "pdf" })}
                    disabled={!canExportDocument || !!pendingExportFor("pdf")?.running}
                    title={exportTooltip("pdf")}
                    data-testid="export-pdf"
                  >
                    Export PDF ({selectedExportable}){langSuffix}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => exportDocumentMutation.mutate({ id: book.id, language: activeVariant ?? undefined, format: "epub" })}
                    disabled={!canExportDocument || !!pendingExportFor("epub")?.running}
                    title={exportTooltip("epub")}
                    data-testid="export-epub"
                  >
                    Export EPUB ({selectedExportable}){langSuffix}
                  </Button>
                  {!rendererReady && (
                    <Button
                      variant="secondary"
                      onClick={() => installRenderer.mutate()}
                      disabled={installRenderer.isPending}
                      title="Vivliostyle renders these two formats and brings its own browser, once"
                      data-testid="install-renderer"
                    >
                      {installRenderer.isPending ? "Downloading renderer…" : "Download page renderer (345 MB)"}
                    </Button>
                  )}
                  <div className="ml-1 flex flex-col gap-1.5 border-l border-(--border) pl-3">
                    <Button
                      variant="secondary"
                      onClick={() => exportDocumentMutation.mutate({
                        id: book.id,
                        language: activeVariant ?? undefined,
                        format: "epub-sync",
                        copyToDropDir: !!exportConfig?.readaloudDropDir && copyToImport,
                        waitForAll: deferOutputs,
                      })}
                      disabled={!canExportSync || !!pendingExportFor("epub-sync")?.running}
                      title={syncExportTooltip}
                      data-testid="export-epub-sync"
                    >
                      Export synced EPUB{deferOutputs ? " when ready" : ""} ({deferOutputs ? selectedCount : selectedSyncExportable}){langSuffix}
                    </Button>
                    {exportConfig?.readaloudDropDir && (
                      <label
                        className="flex w-fit items-center gap-1.5 text-xs text-(--text-muted) cursor-pointer hover:text-(--text-secondary)"
                        title={`Copies the synced EPUB to ${exportConfig.readaloudDropDir} so Storyteller picks it up automatically (READALOUD_DROP_DIR in .env)`}
                      >
                        <input
                          type="checkbox"
                          checked={copyToImport}
                          onChange={(e) => setCopyToImport(e.target.checked)}
                          className="rounded"
                          data-testid="copy-to-import"
                        />
                        Copy to Storyteller import folder
                      </label>
                    )}
                  </div>
                  {viewPendingExports.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-(--step-output)" data-testid="export-pending-inline">
                      <span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse" />
                      {viewPendingExports.map(pendingExportSummary).join(" · ")}...
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        <NotesSection bookId={book.id} noteJob={book.noteJob ?? null} />

        {/* STAGE 3: produced outputs, scoped to the active language view */}
        <div className="space-y-6 mb-6">
          <AudioOutputsSection
            assemblies={bookAssemblies.filter((a) => (a.language ?? null) === activeVariant)}
            latestOutputPath={activeVariant ? null : book.outputPath}
            onDelete={(aid) => deleteAssemblyMutation.mutate({ id: aid })}
            isDeleting={deleteAssemblyMutation.isPending}
          />
          <DocumentOutputsSection
            documents={bookDocuments.filter((d) => (d.language ?? null) === activeVariant)}
            pending={viewPendingExports}
            onDelete={(did) => deleteDocumentMutation.mutate({ id: did })}
            isDeleting={deleteDocumentMutation.isPending}
          />
        </div>

        {/* Danger zone */}
        <section className="rounded-xl border border-(--border) border-t-2 border-t-(--danger)/70 bg-(--bg-card) p-4">
          <h3 className="text-sm font-medium text-(--text-muted) uppercase tracking-wider mb-3">Danger zone</h3>
          <Button
            variant="danger"
            onClick={() => {
              if (confirm("Delete this book and all its audio?")) {
                deleteMutation.mutate({ id: book.id });
              }
            }}
            disabled={deleteMutation.isPending}
          >
            Delete book
          </Button>
        </section>

        <LogDock
          bookId={book.id}
          isProcessing={isProcessing || translationsRunning}
          files={book.files?.map((f) => ({ index: f.index, filename: f.filename }))}
        />

        {showStructure && (
          <StructureModal
            bookId={book.id}
            isProcessing={isProcessing}
            chapterProposal={book.chapterProposal ?? null}
            chapterModel={book.chapterModel ?? null}
            files={book.files?.map((f) => ({ id: f.id, index: f.index, filename: f.filename }))}
            onClose={() => setShowStructure(false)}
            onChanged={invalidate}
          />
        )}

        {askScope && <ChapterAiModal scope={askScope} onClose={() => setAskScope(null)} />}

        {showSynthesize && (
          <SynthesizeModal
            bookLanguage={book.language ?? null}
            count={selectedSynthesizable}
            language={activeLabel}
            voice={(activeVariant && book.variantVoices?.[activeVariant]?.voice) || book.voice}
            speed={(activeVariant && book.variantVoices?.[activeVariant]?.speed) || book.speed}
            onChangeVoice={(voice) =>
              activeVariant
                ? setVariantVoiceMutation.mutate({ bookId: book.id, key: activeVariant, voice })
                : updateSettingsMutation.mutate({ id: book.id, voice })
            }
            onChangeSpeed={(speed) =>
              activeVariant
                ? setVariantVoiceMutation.mutate({ bookId: book.id, key: activeVariant, speed })
                : updateSettingsMutation.mutate({ id: book.id, speed })
            }
            canStart={canProcess && !processSelectedMutation.isPending && !processSelectedAudioMutation.isPending}
            disabledReason={
              selectedSynthesizable === 0 ? (activeVariant ? `No selected chapters have ${activeLabel} text ready or underway` : "No selected chapters are ready for synthesis") :
              !activeVariant && hasActiveChapters ? "Wait for active chapters to finish" :
              isAssembling ? "Wait for assembly to finish" :
              undefined
            }
            onStart={() => {
              if (activeVariant) {
                processSelectedAudioMutation.mutate({ bookId: book.id, key: activeVariant });
              } else {
                processSelectedMutation.mutate({ id: book.id });
              }
              setShowSynthesize(false);
            }}
            onClose={() => setShowSynthesize(false)}
          />
        )}

        {showTranslation && (
          <VariantModal
            bookId={book.id}
            chapters={book.chapters.map((c) => ({ id: c.id, index: c.index, title: c.title }))}
            initialKey={activeVariant ?? book.translationLanguage ?? null}
            onClose={() => {
              setShowTranslation(false);
              invalidateVariants();
            }}
          />
        )}
      </div>
    </div>
  );
}
