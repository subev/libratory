import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router";
import { trpc } from "../trpc.ts";
import { ModelBundleNotice, useModelBundle } from "../components/ModelBundleNotice.tsx";
import { ChapterTable } from "../components/ChapterTable.tsx";
import { SYNTH_BUSY } from "../lib/chapters.ts";
import { SynthesizeModal, type SynthSettings } from "../components/SynthesizeModal.tsx";
import { StructureModal } from "../components/StructureModal.tsx";
import { VariantModal } from "../components/VariantModal.tsx";
import { BookFilesSection } from "../components/BookFilesSection.tsx";
import { AudioOutputsSection } from "../components/AudioOutputsSection.tsx";
import { DocumentOutputsSection } from "../components/DocumentOutputsSection.tsx";
import { LogDock } from "../components/LogDock.tsx";
import { DiskUsageModal, useDiskUsageTotal } from "../components/DiskUsage.tsx";
import { ChapterAiModal, type AiScope } from "../components/ChapterAiModal.tsx";
import { NotesSection } from "../components/NotesSection.tsx";
import { Button } from "../components/Button.tsx";
import { BookShell, TabPanel } from "../components/book/BookShell.tsx";
import { StageTabs } from "../components/book/StageTabs.tsx";
import { BookHeader } from "../components/book/BookHeader.tsx";
import { BookDetailsModal } from "../components/book/BookDetailsModal.tsx";
import { ActionTray, type TrayAction } from "../components/book/ActionTray.tsx";
import { ExportModal, type ExportFormat, type ExportFormatId } from "../components/book/ExportModal.tsx";
import { loadBookSort, sortBooks } from "../lib/book-sort.ts";
import { formatBytes, formatDuration, pendingExportLabel, pendingExportSummary } from "../lib/format.ts";
import { getVoiceLabel } from "../lib/voices.ts";
import { IconStructure } from "../components/icons.tsx";

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
        const hasActiveChapters = data.chapters?.some((c: { status: string }) => SYNTH_BUSY.includes(c.status));
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

  // Returned, not fired: react-query awaits a promise from onSuccess, and callers that await
  // mutateAsync need the refetch to have landed before they read the data back.
  const invalidate = () =>
    Promise.all([
      utils.books.get.invalidate({ id: id! }),
      utils.books.assemblies.invalidate({ bookId: id! }),
      utils.books.documents.invalidate({ bookId: id! }),
      utils.chapters.selectedAudioSize.invalidate({ bookId: id! }),
    ]);

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
  const reExtractSelectedMutation = trpc.bookFiles.reExtractSelected.useMutation({ onSuccess: invalidate });
  const cancelFileMutation = trpc.bookFiles.cancel.useMutation({ onSuccess: invalidate });

  // Opened from the toolbar and from the raw-text block, so it cannot live in either of them.
  const [extractOpen, setExtractOpen] = useState(false);
  const [showStructure, setShowStructure] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const [showSynthesize, setShowSynthesize] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormatId>("epub-sync");
  const [showDetails, setShowDetails] = useState(false);
  const [showDiskUsage, setShowDiskUsage] = useState(false);
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

  const { data: notes = [] } = trpc.notes.list.useQuery({ bookId: id! }, { enabled: !!id });
  const diskTotal = useDiskUsageTotal(id!);

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

  // The lane being viewed decides which stored voice and speed a synthesis will use and change
  const synth: SynthSettings = {
    voice: (activeVariant && book.variantVoices?.[activeVariant]?.voice) || book.voice,
    speed: (activeVariant && book.variantVoices?.[activeVariant]?.speed) || book.speed,
    onChangeVoice: (voice) =>
      activeVariant
        ? setVariantVoiceMutation.mutate({ bookId: book.id, key: activeVariant, voice })
        : updateSettingsMutation.mutate({ id: book.id, voice }),
    onChangeSpeed: (speed) =>
      activeVariant
        ? setVariantVoiceMutation.mutate({ bookId: book.id, key: activeVariant, speed })
        : updateSettingsMutation.mutate({ id: book.id, speed }),
  };

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
  const hasActiveChapters = viewChapters.some((c) => SYNTH_BUSY.includes(c.status));
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
  const selectedInFlight = viewChapters.filter((c) => c.selected && SYNTH_BUSY.includes(c.status)).length;
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

  const fileCount = book.files?.length ?? 0;
  const totalDurationMs = viewChapters.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
  const headMeta = [
    fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null,
    `${book.chapters.length} chapter${book.chapters.length === 1 ? "" : "s"}`,
    totalDurationMs > 0 ? formatDuration(totalDurationMs) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Locked only while there is nothing to show. Extracting a fourth file into a book that already
  // has chapters must not take the table away — that is a multi-file book's normal working state.
  const stagesLocked = book.chapters.length === 0 && (book.status === "extracting" || hasActiveFiles);
  const hasNotes = notes.length > 0 || !!book.noteJob;
  // ?chapter= is read inside ChapterTable and is how a chat citation and the reader's Back link open
  // a chapter. Landing on any other tab would make both of them silently do nothing.
  const visibleTabs = ["files", "chapters", "outputs", ...(hasNotes ? ["notes"] : [])];
  const requestedTab = searchParams.get("tab");
  // Clamped to a tab that is actually rendered: deleting the last note takes the Notes tab away
  // while ?tab=notes is still in the URL, and an unmatched value leaves every panel hidden.
  const tab = searchParams.has("chapter")
    ? "chapters"
    : stagesLocked
      ? "files"
      : requestedTab && visibleTabs.includes(requestedTab)
        ? requestedTab
        : book.chapters.length === 0
          ? "files"
          : "chapters";
  const setTab = (next: string) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        return params;
      },
      { replace: true },
    );

  const extractingFiles = book.files?.filter((f) => f.status === "extracting").length ?? 0;
  const synthesizingCount = viewChapters.filter((c) => SYNTH_BUSY.includes(c.status)).length;
  const chaptersWithAudio = viewChapters.filter((c) => c.audioPath).length;
  const outputCount = bookAssemblies.filter((a) => (a.language ?? null) === activeVariant).length +
    bookDocuments.filter((d) => (d.language ?? null) === activeVariant).length;

  const deleteAudioAction = {
    count: audioDataCount,
    size: audioDataSize,
    disabled: audioDataCount === 0 || hasActiveChapters || deleteAudioMutation.isPending || deleteVariantAudioMutation.isPending,
    title:
      audioDataCount === 0
        ? "No selected chapters have synthesized audio on disk"
        : hasActiveChapters
          ? "Wait for active chapters to finish"
          : `Delete the synthesized${activeVariant ? ` ${activeLabel}` : ""} audio files and WAV chunks of the selected chapters (${audioDataSize}) — text is kept, re-synthesize anytime`,
    onDelete: () => {
      if (
        confirm(
          `Delete the synthesized${activeVariant ? ` ${activeLabel}` : ""} audio files and WAV chunks of ${audioDataCount} selected chapter(s), freeing ${audioDataSize}? ${activeVariant ? "Variant text" : "Chapters and text"} are kept — you can re-synthesize anytime.`,
        )
      ) {
        if (activeVariant) {
          deleteVariantAudioMutation.mutate({ bookId: book.id, key: activeVariant });
        } else {
          deleteAudioMutation.mutate({ bookId: book.id });
        }
      }
    },
  };

  const trayActions: TrayAction[] = [
    ...(hasActiveChapters || translationAudioQueued
      ? [{
          id: "cancel-processing",
          label: "Cancel processing",
          pinned: true,
          onClick: () =>
            activeVariant ? stopAudioMutation.mutate({ bookId: book.id, key: activeVariant }) : cancelMutation.mutate({ id: book.id }),
          disabled: cancelMutation.isPending || stopAudioMutation.isPending,
          title: "Stop the running synthesis — finished chapters keep their audio, the rest resume later",
        }]
      : []),
    {
      id: "synthesize",
      label: `Synthesize (${selectedSynthesizable})${langSuffix}`,
      pinned: true,
      onClick: () => setShowSynthesize(true),
      disabled: selectedSynthesizable === 0,
      title:
        selectedSynthesizable === 0
          ? activeVariant
            ? `No selected chapters have ${activeLabel} text ready or underway`
            : "No selected chapters are ready for synthesis"
          : "Pick voice and speed, then synthesize the selected chapters",
    },
    {
      id: "translate",
      label: `${activeKind === "translation" ? "Translate" : "Rewrite"} (${selectedTranslatable})`,
      onClick: () => processSelectedVariantsMutation.mutate({ bookId: book.id, key: activeVariant! }),
      disabled: !activeVariant || selectedTranslatable === 0 || processSelectedVariantsMutation.isPending,
      title: !activeVariant
        ? "Open a variant view to run it on the selected chapters"
        : selectedTranslatable === 0
          ? "No selected chapters need this — finished ones are skipped"
          : activeKind === "translation"
            ? `Translate the selected chapters to ${activeLabel} (finished ones are skipped, stopped ones resume)`
            : `Rewrite the selected chapters as ${activeLabel} (finished ones are skipped, stopped ones resume)`,
    },
    {
      id: "cleanup",
      label: `Cleanup (${selectedCleanable})`,
      onClick: () => cleanupSelectedMutation.mutate({ bookId: book.id }),
      disabled: !!activeVariant || selectedCleanable === 0 || cleanupSelectedMutation.isPending,
      title: activeVariant
        ? "Switch to the original view — cleanup runs on the original text"
        : selectedCleanable === 0
          ? "No selected chapters need cleanup — already-cleaned and running ones are skipped"
          : "Ask AI to strip OCR artifacts from the selected chapters without altering the prose",
    },
    {
      id: "ask-ai",
      label: "Ask AI",
      onClick: () => {
        const selected = book.chapters.filter((c) => c.selected).map((c) => ({ id: c.id, title: c.title }));
        setAskScope(
          selected.length > 0 && !activeVariant
            ? { kind: "chapters", bookId: book.id, chapters: selected }
            : { kind: "book-raw", bookId: book.id, bookTitle: book.title, chapters: selected },
        );
      },
      disabled: book.rawTextTotalWords === 0 && (selectedCount === 0 || !!activeVariant),
      title:
        book.rawTextTotalWords === 0 && selectedCount === 0
          ? "No raw text or chapters to ask about"
          : "Summarize, question, or run any prompt — switch between selected chapters and the whole book inside",
    },
    {
      id: "delete",
      label: `Delete (${selectedCount})`,
      danger: true,
      onClick: () => {
        if (confirm(`Delete ${selectedCount} selected chapter(s) and their audio?`)) {
          deleteChaptersMutation.mutate({ bookId: book.id });
        }
      },
      disabled: selectedCount === 0 || hasActiveChapters || !!activeVariant || deleteChaptersMutation.isPending,
      title: activeVariant
        ? "Switch to the original view to delete chapters"
        : selectedCount === 0
          ? "No chapters selected"
          : hasActiveChapters
            ? "Wait for active chapters to finish"
            : "Delete the selected chapters and their audio",
    },
  ];

  const exportFormats: ExportFormat[] = [
    {
      id: "epub-sync",
      label: "synced EPUB",
      subtitle: "Text and audio locked together — read-along narration",
      count: deferOutputs ? selectedCount : selectedSyncExportable,
      disabled: !canExportSync || !!pendingExportFor("epub-sync")?.running,
      reason: syncExportTooltip,
      recommended: true,
    },
    {
      id: "m4b",
      label: "audiobook",
      subtitle: "M4B with chapter marks and a cover",
      count: deferOutputs ? selectedCount : selectedWithAudio,
      disabled: !canAssemble || assembleMutation.isPending || assembleVariantMutation.isPending,
      reason:
        selectedCount === 0
          ? "No chapters selected"
          : deferOutputs
            ? `Queue the assembly now — it runs once the ${selectedInFlight} chapter(s) still synthesizing are finished`
            : !allSelectedDone
              ? "All selected chapters must be done with audio"
              : isAssembling
                ? "Assembly already in progress"
                : undefined,
    },
    {
      id: "epub",
      label: "EPUB",
      subtitle: "Text only · any e-reader",
      count: selectedExportable,
      disabled: !canExportDocument || !!pendingExportFor("epub")?.running,
      reason: exportTooltip("epub"),
    },
    {
      id: "pdf",
      label: "PDF",
      subtitle: rendererReady ? "Text only · typeset pages" : "Text only · needs the page renderer",
      count: selectedExportable,
      disabled: !canExportDocument || !!pendingExportFor("pdf")?.running,
      reason: exportTooltip("pdf"),
      extra: !rendererReady ? (
        <div className="pl-8 pt-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => installRenderer.mutate()}
            disabled={installRenderer.isPending}
            title="Vivliostyle renders PDF and EPUB and brings its own browser, once"
            data-testid="install-renderer"
          >
            {installRenderer.isPending ? "Downloading renderer…" : "Download page renderer (345 MB)"}
          </Button>
        </div>
      ) : undefined,
    },
  ];

  // Opening on a format that cannot run would present a dead CTA, and which formats can run
  // changes as chapters finish — so the pick falls back rather than being pinned at first render.
  const pickedExport =
    exportFormats.find((f) => f.id === exportFormat && !f.disabled)?.id ??
    exportFormats.find((f) => !f.disabled)?.id ??
    exportFormat;

  const runExport = () => {
    if (pickedExport === "m4b") {
      if (activeVariant) assembleVariantMutation.mutate({ bookId: book.id, key: activeVariant, waitForAll: deferOutputs });
      else assembleMutation.mutate({ id: book.id, waitForAll: deferOutputs });
    } else {
      exportDocumentMutation.mutate({
        id: book.id,
        language: activeVariant ?? undefined,
        format: pickedExport,
        ...(pickedExport === "epub-sync"
          ? { copyToDropDir: !!exportConfig?.readaloudDropDir && copyToImport, waitForAll: deferOutputs }
          : {}),
      });
    }
    setExportOpen(false);
    setTab("outputs");
  };

  const startRefusal =
    setAutoSynthesizeMutation.error ??
    reExtractSelectedMutation.error ??
    retryMutation.error ??
    redetectMutation.error ??
    setAllFilesSelectedMutation.error ??
    setFileSelectedBatchMutation.error;

  return (
    <BookShell
      header={
        <BookHeader
          bookId={book.id}
          title={book.title}
          headMeta={headMeta}
          crumbs={[
            { to: "/", label: "Home" },
            ...(book.folderPath ?? []).map((f) => ({ to: `/folders/${f.id}`, label: f.name })),
          ]}
          searchIndex={orderedBooks.find((b) => b.id === book.id)?.searchIndex}
          hasChapters={book.chapters.length > 0}
          onRename={(title) => renameMutation.mutate({ id: book.id, title })}
          prevBook={prevBook ?? null}
          nextBook={nextBook ?? null}
          position={bookIndex >= 0 ? { index: bookIndex + 1, total: orderedBooks.length, sortKey: bookSort.key } : null}
          onNavigate={(target) => navigate(`/books/${target}`)}
          canRead={hasChapterAudio || hasChapterPages}
          readTitle={
            !(hasChapterAudio || hasChapterPages)
              ? "No chapter is on a page yet — extract chapters to read this book on its own print"
              : hasChapterAudio
                ? "Follow the narration on the PDF page, and tap a sentence to jump there"
                : "Read the book's own pages — synthesize a chapter to follow the narration across them"
          }
          onAsk={() => setAskScope({ kind: "book-raw", bookId: book.id, bookTitle: book.title })}
          askDisabled={!hasRawText}
          askTitle={
            hasRawText
              ? "Ask AI about this book — one call, the whole text goes to the model"
              : "No raw text — the PDF may be scanned; run Extract chapters with Force OCR instead"
          }
          lanes={variantLanes}
          activeVariant={activeVariant}
          bookLanguage={book.language ?? null}
          chapterCount={book.chapters.length}
          onSwitchVariant={setActiveVariant}
          onAddVariant={() => setShowTranslation(true)}
          addVariantDisabled={book.chapters.length === 0}
          addVariantTitle={
            book.chapters.length === 0
              ? "Extract chapters first"
              : "Translate or rewrite chapters (ELI5, summary, custom prompts) and review side by side"
          }
          onExtract={() => setExtractOpen(true)}
          extractDisabled={book.kind !== "pdf"}
          extractTitle={
            book.kind !== "pdf"
              ? "Synthetic book — its chapters were not extracted from a file"
              : "Choose what to re-read and with which settings"
          }
          onDetails={() => setShowDetails(true)}
          onDiskUsage={() => setShowDiskUsage(true)}
          diskTotal={diskTotal}
          deleteAudio={deleteAudioAction}
          onDeleteBook={() => {
            if (confirm("Delete this book and all its audio?")) deleteMutation.mutate({ id: book.id });
          }}
        />
      }
      tabs={
        <StageTabs
          value={tab}
          onChange={setTab}
          hint={tab === "chapters" ? `${chaptersWithAudio} of ${book.chapters.length} chapters have audio` : undefined}
          tabs={[
            {
              id: "files",
              step: 1,
              label: "Source files",
              count: fileCount || undefined,
              title: "The files this book was built from, in reading order",
              badge: extractingFiles > 0 ? { text: `extracting ${extractingFiles}`, tone: "extracting" as const } : null,
            },
            {
              id: "chapters",
              step: 2,
              label: "Chapters",
              count: stagesLocked ? "—" : book.chapters.length,
              locked: stagesLocked,
              title: stagesLocked ? "Locked — extract chapters from a source file first" : "Every chapter, its audio and its text",
              badge: synthesizingCount > 0 ? { text: `${synthesizingCount} synthesizing`, tone: "synthesizing" as const } : null,
            },
            {
              id: "outputs",
              step: 3,
              label: "Outputs",
              count: stagesLocked ? "—" : outputCount,
              locked: stagesLocked,
              title: stagesLocked ? "Locked — no chapters yet, so nothing can be built" : "Finished audiobooks and documents",
              badge:
                isAssembling || book.assembleQueued
                  ? { text: "assembling", tone: "assembling" as const }
                  : viewPendingExports.length > 0
                    ? { text: viewPendingExports.map(pendingExportSummary).join(" · "), tone: "assembling" as const }
                    : null,
            },
            ...(hasNotes
              ? [
                  {
                    id: "notes",
                    label: "Notes",
                    count: notes.length,
                    trailing: true,
                    title: "AI answers saved about this book",
                    badge:
                      book.noteJob?.status === "queued" || book.noteJob?.status === "running"
                        ? { text: "answering", tone: "synthesizing" as const }
                        : null,
                  },
                ]
              : []),
          ]}
        />
      }
      banner={
        activeVariant ? (
          <div
            className="flex items-center gap-2 px-4 py-1.5 bg-(--accent-subtle) border-b border-(--border) text-xs"
            data-testid="translation-view-banner"
          >
            <span className="font-bold text-(--accent-text)">
              {activeLabel} {activeKind === "translation" ? "translation" : "rewrite"} view
            </span>
            <span className="text-(--text-secondary) truncate">
              chapters, audio and outputs below are this version
              {translationsRunning ? (activeKind === "translation" ? " — translation in progress..." : " — rewrite in progress...") : ""}
            </span>
            <div className="flex-1" />
            {missingTitleCount > 0 && (
              <button
                onClick={() => translateTitlesMutation.mutate({ bookId: book.id, key: activeVariant })}
                disabled={translateTitlesMutation.isPending || titlesRequested}
                title={`Translate the ${missingTitleCount} chapter title${missingTitleCount === 1 ? "" : "s"} still shown in the original language`}
                className="text-xs font-semibold text-(--accent-text) hover:underline shrink-0 disabled:opacity-50 disabled:no-underline"
                data-testid="translate-titles"
              >
                {titlesRequested ? `Translating titles (${missingTitleCount} left)...` : `Translate titles (${missingTitleCount})`}
              </button>
            )}
            <button
              onClick={() => setActiveVariant(null)}
              className="text-xs font-semibold text-(--accent-text) hover:underline shrink-0"
            >
              Back to original
            </button>
          </div>
        ) : null
      }
      tray={
        tab === "chapters" && book.chapters.length > 0 ? (
          <ActionTray
            title={selectedCount === book.chapters.length ? `All ${selectedCount} selected` : `${selectedCount} of ${book.chapters.length} selected`}
            subtitle={
              selectedInFlight > 0
                ? `${chaptersWithAudio} with audio · ${selectedInFlight} in flight`
                : `${chaptersWithAudio} with audio`
            }
            actions={trayActions}
            primary={
              <Button variant="primary" size="sm" onClick={() => setExportOpen(true)} data-testid="open-export">
                Export…
              </Button>
            }
          />
        ) : null
      }
      dock={
        <LogDock
          bookId={book.id}
          isProcessing={isProcessing || translationsRunning}
          files={book.files?.map((f) => ({ index: f.index, filename: f.filename }))}
        />
      }
    >
      {(startRefusal || book.error) && (
        <div className="px-4 pt-4 space-y-2">
          {startRefusal && (
            <div className="bg-(--danger-bg) border border-(--danger) rounded-lg p-3" data-testid="extract-start-error">
              <p className="text-sm text-(--danger-text)">Could not start: {startRefusal.message}</p>
            </div>
          )}
          {/* "All N file(s) failed extraction" only counts what the rows below already say, and says
              it louder than the reason. */}
          {book.error && !/^All \d+ file\(s\) failed extraction$/.test(book.error) && (
            <div className="bg-(--danger-bg) border border-(--danger) rounded-lg p-3">
              <p className="text-sm text-(--danger-text) font-mono">{book.error}</p>
            </div>
          )}
        </div>
      )}

      <TabPanel active={tab === "files"}>
        <div className="p-4">
          {book.kind === "pdf" ? (
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
              onSetAllSelected={(selected) => setAllFilesSelectedMutation.mutateAsync({ bookId: book.id, selected })}
              onSetSelectedBatch={(ids, selected) => setFileSelectedBatchMutation.mutateAsync({ ids, selected })}
              onRemove={(fid) => removeFileMutation.mutate({ id: fid })}
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
          ) : (
            <p className="text-sm text-(--text-muted)" data-testid="synthetic-no-input">
              {book.kind === "digest"
                ? "Chapters were written from other books in your library — a digest has no source files to upload or extract."
                : "Chapters arrived through the API — this book has no source files to upload or extract."}
            </p>
          )}

          {book.chapters.length === 0 && (
            <div className="mt-4">
              {isSynthetic ? (
                <div className="rounded-lg border border-(--border) bg-(--bg-subtle) p-4 space-y-3" data-testid="digest-block">
                  {digestLive ? (
                    <div className="flex items-center gap-2 text-sm text-(--text-secondary)">
                      <span className="w-2 h-2 rounded-full bg-(--accent) animate-[pulse-dot_1.15s_ease-in-out_infinite]" />
                      Generating digest — {book.digestJob?.progress ? `${book.digestJob.progress} books` : "starting"}... chapters appear as summaries finish.
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-(--text-secondary)">
                        {digestFailed ? `Digest failed: ${book.digestJob?.error ?? "unknown error"}` : "No chapters were generated."}
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
                      {resumeDigestMutation.error && <p className="text-(--danger-text) text-sm">{resumeDigestMutation.error.message}</p>}
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
                      title={
                        extractionReady
                          ? "Choose what to read and with which settings, then start — Marker takes minutes per book"
                          : "Full extraction needs the Marker models — download them below"
                      }
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
              )}
            </div>
          )}
        </div>
      </TabPanel>

      <TabPanel active={tab === "chapters"} scroll={false}>
        <div className="p-4 flex flex-col min-h-0 flex-1">
          {book.chapters.length === 0 ? (
            <p className="text-sm text-(--text-muted)">No chapters yet — extract them from the source files.</p>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3 flex-wrap shrink-0">
                <Button
                  variant="secondary"
                  onClick={() => setShowStructure(true)}
                  disabled={book.kind !== "pdf"}
                  title={
                    book.kind !== "pdf"
                      ? "Synthetic book — no PDF structure to edit"
                      : "Review every detected heading and edit chapter boundaries by hand"
                  }
                  data-testid="open-structure"
                >
                  <IconStructure className="w-4 h-4 text-(--accent-text)" />
                  Structure
                </Button>
                {book.chapterDetection && (
                  <span
                    className="text-xs px-2 py-0.5 rounded-full bg-(--bg-subtle) text-(--text-muted)"
                    title={
                      {
                        llm: "Boundaries picked by AI from the table of contents",
                        "numbered-headings": "Numbered chapter headings (Chapter N) found in the document",
                        "heading-levels": "Split at the most plausible heading level",
                        "word-split": "No usable headings — split every ~5000 words",
                        manual: "Boundaries chosen by hand in the structure view",
                      }[book.chapterDetection]
                    }
                  >
                    {
                      {
                        llm: "LLM · ToC-matched",
                        "numbered-headings": "Chapter numbering",
                        "heading-levels": "Heading heuristic",
                        "word-split": "Word-count split",
                        manual: "Manual boundaries",
                      }[book.chapterDetection]
                    }
                  </span>
                )}
                <div className="flex-1" />
                <span className="text-sm text-(--text-muted)">
                  {selectedCount} of {book.chapters.length} selected
                </span>
              </div>

              {isSynthetic && digestLive && (
                <div className="flex items-center gap-2 text-sm text-(--text-muted) mb-2" data-testid="digest-progress">
                  <span className="w-2 h-2 rounded-full bg-(--accent) animate-[pulse-dot_1.15s_ease-in-out_infinite]" />
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
                synth={synth}
              />

            </>
          )}
        </div>
      </TabPanel>

      <TabPanel active={tab === "outputs"}>
        <div className="p-4 space-y-6">
          <AudioOutputsSection
            action={
              book.chapters.length > 0 ? (
                <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)} data-testid="outputs-export">
                  Export…
                </Button>
              ) : undefined
            }
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
      </TabPanel>

      <TabPanel active={tab === "notes"}>
        <div className="p-4">
          <NotesSection bookId={book.id} noteJob={book.noteJob ?? null} />
        </div>
      </TabPanel>

      {exportOpen && (
        <ExportModal
          formats={exportFormats}
          value={pickedExport}
          onChange={setExportFormat}
          scopeSummary={
            selectedCount === book.chapters.length
              ? `All ${selectedCount} chapters — everything is selected`
              : `${selectedCount} of ${book.chapters.length} chapters — narrow it in the Chapters tab`
          }
          timing={{
            inFlight: selectedInFlight,
            readyCount: pickedExport === "m4b" ? selectedWithAudio : selectedSyncExportable,
            totalCount: selectedCount,
            waitForAll,
            onChange: setWaitForAll,
          }}
          dropDir={
            exportConfig?.readaloudDropDir
              ? { path: exportConfig.readaloudDropDir, checked: copyToImport, onChange: setCopyToImport }
              : null
          }
          busy={exportDocumentMutation.isPending || assembleMutation.isPending || assembleVariantMutation.isPending}
          onConfirm={runExport}
          onClose={() => setExportOpen(false)}
        />
      )}

      {showDetails && (
        <BookDetailsModal
          author={book.author ?? null}
          language={book.language ?? null}
          onSave={(patch) => updateSettingsMutation.mutate({ id: book.id, ...patch })}
          onClose={() => setShowDetails(false)}
        />
      )}

      {showDiskUsage && <DiskUsageModal bookId={book.id} onClose={() => setShowDiskUsage(false)} />}

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
          {...synth}
          canStart={canProcess && !processSelectedMutation.isPending && !processSelectedAudioMutation.isPending}
          disabledReason={
            selectedSynthesizable === 0
              ? activeVariant
                ? `No selected chapters have ${activeLabel} text ready or underway`
                : "No selected chapters are ready for synthesis"
              : !activeVariant && hasActiveChapters
                ? "Wait for active chapters to finish"
                : isAssembling
                  ? "Wait for assembly to finish"
                  : undefined
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
    </BookShell>
  );
}
