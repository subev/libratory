import { useEffect, useRef, useState } from "react";
import { trpc } from "../trpc.ts";
import { PdfPreviewModal } from "./PdfPreviewModal.tsx";
import { Modal, ModalHeader } from "./Modal.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { Button } from "./Button.tsx";
import type { ChapterProposal } from "../../../server/src/schema.ts";
import { isLabelSized, oversizedIndices, PREFACE_MIN_WORDS } from "../../../server/src/lib/chapter-rules.ts";

type StructureFile = {
  fileIndex: number | null;
  filename: string;
  missing: boolean;
  totalWords: number;
  totalPages: number;
  headings: {
    blockIndex: number;
    page: number;
    level: number | null;
    text: string;
    wordsBefore: number;
    isChapterStart: boolean;
  }[];
};

function boundaryKey(fileIndex: number | null, blockIndex: number) {
  return `${fileIndex ?? "legacy"}:${blockIndex}`;
}

type PreviewChapter = {
  key: string;
  title: string;
  translated: string | undefined;
  pageStart: number;
  pageEnd: number;
  words: number;
  anomaly?: "long" | "short";
};

function flagAnomalies(chapters: PreviewChapter[]): PreviewChapter[] {
  const long = oversizedIndices(chapters.map((c) => c.words));
  return chapters.map((c, i) => {
    if (long.has(i)) return { ...c, anomaly: "long" };
    if (c.key !== "preface" && isLabelSized(c.words, i, chapters.length)) return { ...c, anomaly: "short" };
    return c;
  });
}

function anomalyHint(ch: PreviewChapter): string | undefined {
  if (ch.anomaly === "long") return "Much longer than the other chapters: a chapter heading inside it is probably unchecked";
  if (ch.anomaly === "short") return `Only ${ch.words} words: probably a label, a part-title page, or a duplicate heading`;
  return undefined;
}

function pageRange(pages: number[]) {
  if (pages.length === 0) return "?";
  const min = Math.min(...pages);
  const max = Math.max(...pages);
  return min === max ? `p.${min}` : `p.${min}–${max}`;
}

export function StructureModal({
  bookId,
  isProcessing,
  chapterProposal,
  chapterModel,
  confirmed,
  files,
  onClose,
  onChanged,
}: {
  bookId: string;
  isProcessing: boolean;
  chapterProposal: ChapterProposal | null;
  chapterModel: string | null;
  confirmed: boolean;
  files?: { id: string; index: number; filename: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data: structure, isLoading } = trpc.books.structure.useQuery({ id: bookId });
  const [model, setModel] = useState<string>(chapterModel ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pdfPreview, setPdfPreview] = useState<{ fileId: string; page: number; filename?: string } | null>(null);
  const initialized = useRef(false);
  const lastClickedIndex = useRef<number | null>(null);
  const toggleAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialized.current || !structure) return;
    initialized.current = true;
    const initial = new Set<string>();
    for (const file of structure.files) {
      for (const h of file.headings) {
        if (h.isChapterStart) initial.add(boundaryKey(file.fileIndex, h.blockIndex));
      }
    }
    setSelected(initial);
  }, [structure]);

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

  const { data: runningLogs } = trpc.books.logs.useQuery(
    { bookId },
    { enabled: proposalRunning, refetchInterval: 2000 }
  );
  const proposalProgress = proposalRunning
    ? runningLogs
        ?.filter(
          (l) =>
            l.message.startsWith("[AI]") &&
            chapterProposal &&
            new Date(l.createdAt) >= new Date(chapterProposal.createdAt)
        )
        .at(-1)?.message
    : undefined;

  // LLM proposals carry cleaned-up (and optionally translated) titles; keep them through preview and apply
  const proposalBoundaries = chapterProposal?.status === "done" ? chapterProposal.boundaries ?? [] : [];
  const proposalTitles = new Map(proposalBoundaries.map((b) => [boundaryKey(b.fileIndex, b.blockIndex), b.title]));
  const proposalTranslations = new Map(
    proposalBoundaries
      .filter((b) => b.titleTranslated)
      .map((b) => [boundaryKey(b.fileIndex, b.blockIndex), b.titleTranslated!])
  );

  const allKeys =
    structure?.files.flatMap((file) => file.headings.map((h) => boundaryKey(file.fileIndex, h.blockIndex))) ?? [];
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  useEffect(() => {
    if (toggleAllRef.current) {
      toggleAllRef.current.indeterminate = !allSelected && selected.size > 0;
    }
  }, [allSelected, selected.size]);

  function handleToggleAll() {
    setSelected(allSelected ? new Set() : new Set(allKeys));
  }

  function handleCheckboxClick(key: string, e: React.MouseEvent) {
    const idx = allKeys.indexOf(key);
    const newValue = !selected.has(key);
    if (e.shiftKey && lastClickedIndex.current !== null) {
      const from = Math.min(lastClickedIndex.current, idx);
      const to = Math.max(lastClickedIndex.current, idx);
      const range = allKeys.slice(from, to + 1);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const k of range) {
          if (newValue) next.add(k);
          else next.delete(k);
        }
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (newValue) next.add(key);
        else next.delete(key);
        return next;
      });
    }
    lastClickedIndex.current = idx;
  }

  function useProposal() {
    if (!chapterProposal?.boundaries) return;
    setSelected(new Set(chapterProposal.boundaries.map((b) => boundaryKey(b.fileIndex, b.blockIndex))));
  }

  function apply() {
    if (!structure) return;
    const boundaries = structure.files.flatMap((file) =>
      file.headings
        .filter((h) => selected.has(boundaryKey(file.fileIndex, h.blockIndex)))
        .map((h) => ({
          fileIndex: file.fileIndex,
          blockIndex: h.blockIndex,
          title: proposalTitles.get(boundaryKey(file.fileIndex, h.blockIndex)),
        }))
    );
    if (boundaries.length === 0) return;
    if (unchanged) {
      confirmMutation.mutate({ id: bookId });
      return;
    }
    if (!confirm(`Re-slice the book into ${boundaries.length} chapters? Existing chapters, audio, and assemblies will be deleted.`)) return;
    applyMutation.mutate({ id: bookId, boundaries });
  }

  function pdfFileFor(fileIndex: number | null) {
    return files?.find((f) => f.index === fileIndex) ?? (files?.length === 1 ? files[0] : undefined);
  }

  function previewFor(file: StructureFile): PreviewChapter[] {
    const chosen = file.headings.filter((h) => selected.has(boundaryKey(file.fileIndex, h.blockIndex)));
    if (chosen.length === 0) {
      return [
        { key: "full", title: "Full Text", translated: undefined, pageStart: 1, pageEnd: file.totalPages, words: file.totalWords },
      ];
    }
    const chapters: PreviewChapter[] = chosen.map((h, i) => {
      const next = chosen[i + 1];
      const key = boundaryKey(file.fileIndex, h.blockIndex);
      return {
        key: `${h.blockIndex}`,
        title: proposalTitles.get(key) ?? h.text,
        translated: proposalTranslations.get(key),
        pageStart: h.page,
        pageEnd: next ? next.page : file.totalPages,
        words: (next ? next.wordsBefore : file.totalWords) - h.wordsBefore,
      };
    });
    const firstChosen = chosen[0];
    if (firstChosen && firstChosen.wordsBefore > PREFACE_MIN_WORDS) {
      chapters.unshift({
        key: "preface",
        title: "Preface",
        translated: undefined,
        pageStart: 1,
        pageEnd: firstChosen.page,
        words: firstChosen.wordsBefore,
      });
    }
    return flagAnomalies(chapters);
  }

  const selectedCount = selected.size;
  // The chapters as they stand, unchanged: applying them records the review and replaces nothing
  const currentStarts = structure?.files.flatMap((file) => file.headings.filter((h) => h.isChapterStart).map((h) => boundaryKey(file.fileIndex, h.blockIndex))) ?? [];
  const unchanged = currentStarts.length === selectedCount && currentStarts.every((key) => selected.has(key) && !proposalTitles.has(key));

  return (
    <>
      <Modal size="xl" onClose={onClose} backdropTestId="structure-modal">
        <ModalHeader
          title="Book structure"
          subtitle="Every heading found in the extraction output. Check the ones that start a chapter, then apply."
          onClose={onClose}
        />

        {chapterProposal && chapterProposal.status !== "running" ? (
          <div
            className={`px-4 py-2 border-b border-(--border) text-sm flex items-center gap-3 ${
              chapterProposal.status === "failed" ? "bg-(--danger-bg) text-(--danger-text)" : "bg-(--bg-subtle) text-(--text-secondary)"
            }`}
            data-testid="proposal-banner"
          >
            {chapterProposal.status === "done" ? (
              <>
                <span>
                  Proposal ready: {chapterProposal.boundaries?.length ?? 0} boundaries
                  {chapterProposal.detection ? ` (${chapterProposal.detection})` : ""}
                </span>
                {chapterProposal.toc?.map((t) => (
                  <span
                    key={t.fileIndex ?? "legacy"}
                    className="text-(--text-muted) truncate"
                    title={t.entries.map((e) => `${"  ".repeat(e.level ?? 0)}${e.title}${e.page !== null ? ` · ${e.page}` : ""}`).join("\n")}
                    data-testid="proposal-toc"
                  >
                    ToC on {pageRange(t.pages)}: {t.entries.length} entries, {t.chapterEntries} chapters
                    {t.offsets ? `, page offset ${t.offsets}` : ""}
                  </span>
                ))}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={useProposal}
                  data-testid="use-proposal"
                >
                  Use proposal
                </Button>
              </>
            ) : (
              <span>Proposal failed: {chapterProposal.error}</span>
            )}
          </div>
        ) : null}

        <div className="flex-1 flex min-h-0">
          <div className="flex-1 overflow-y-auto p-4 border-r border-(--border)">
            {isLoading ? (
              <p className="text-sm text-(--text-muted)">Loading structure...</p>
            ) : (
              <>
              {allKeys.length > 0 ? (
                <label className="flex items-center gap-2 px-2 py-1 mb-1 rounded cursor-pointer text-sm text-(--text-secondary) hover:bg-(--bg-subtle) select-none border-b border-(--border)">
                  <span className="shrink-0 w-6" />
                  <input
                    ref={toggleAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={handleToggleAll}
                    className="rounded shrink-0"
                    data-testid="select-all-headings"
                  />
                  Select all ({allKeys.length})
                </label>
              ) : null}
              {structure?.files.map((file) => {
                const chapterNumbers = new Map(
                  previewFor(file).flatMap((ch, i) => (ch.key === "preface" || ch.key === "full" ? [] : [[ch.key, i + 1] as const]))
                );
                return (
                <div key={file.fileIndex ?? "legacy"} className="mb-4">
                  {structure.files.length > 1 || file.missing ? (
                    <h3 className="text-xs font-medium text-(--text-muted) uppercase tracking-wider mb-2">
                      {file.filename}
                      {file.missing ? " — extraction output missing" : ""}
                    </h3>
                  ) : null}
                  {file.headings.map((h) => {
                    const key = boundaryKey(file.fileIndex, h.blockIndex);
                    const pdfFile = pdfFileFor(file.fileIndex);
                    return (
                      <label
                        key={key}
                        className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-sm hover:bg-(--bg-subtle) select-none ${
                          selected.has(key) ? "bg-(--bg-selected)" : ""
                        }`}
                      >
                        <span
                          className="shrink-0 w-6 text-right text-xs font-mono tabular-nums text-(--accent-text)"
                          data-testid={chapterNumbers.has(String(h.blockIndex)) ? "chapter-number" : undefined}
                        >
                          {chapterNumbers.has(String(h.blockIndex)) ? `${chapterNumbers.get(String(h.blockIndex))}.` : ""}
                        </span>
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          onChange={() => {}}
                          onClick={(e) => handleCheckboxClick(key, e)}
                          className="rounded shrink-0"
                        />
                        {h.level ? (
                          <span className="shrink-0 text-[10px] font-mono px-1 rounded bg-(--bg-subtle) text-(--text-faint)">
                            H{h.level}
                          </span>
                        ) : null}
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-(--text-primary)" title={h.text}>
                            {h.text}
                          </span>
                          {proposalTranslations.has(key) ? (
                            <span
                              className="block truncate text-xs text-(--text-muted) italic"
                              title={proposalTranslations.get(key)}
                            >
                              {proposalTranslations.get(key)}
                            </span>
                          ) : null}
                        </span>
                        {pdfFile ? (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              setPdfPreview({ fileId: pdfFile.id, page: h.page, filename: pdfFile.filename });
                            }}
                            className="shrink-0 text-xs text-(--accent-text) hover:text-(--accent-text-hover) tabular-nums"
                            title="Open the source PDF at this page"
                          >
                            p.{h.page}
                          </button>
                        ) : (
                          <span className="shrink-0 text-xs text-(--text-muted) tabular-nums">p.{h.page}</span>
                        )}
                      </label>
                    );
                  })}
                  {!file.missing && file.headings.length === 0 ? (
                    <p className="text-sm text-(--text-muted)">No headings found in this file.</p>
                  ) : null}
                </div>
                );
              })}
              </>
            )}
          </div>

          <div className="w-96 shrink-0 overflow-y-auto p-4 bg-(--bg-subtle)/50">
            <h3 className="text-xs font-medium text-(--text-muted) uppercase tracking-wider mb-2">
              Resulting chapters
            </h3>
            {structure?.files.map((file) => {
              const pdfFile = pdfFileFor(file.fileIndex);
              return (
                <div key={file.fileIndex ?? "legacy"} className="mb-3">
                  {structure.files.length > 1 ? (
                    <p className="text-xs text-(--text-faint) mb-1 truncate">{file.filename}</p>
                  ) : null}
                  {previewFor(file).map((ch, i) => (
                    <div
                      key={ch.key}
                      className={`flex items-baseline gap-2 py-0.5 px-1 -mx-1 rounded text-sm ${ch.anomaly ? "bg-(--warning-bg)" : ""}`}
                      title={anomalyHint(ch)}
                      data-testid={ch.anomaly ? "chapter-anomaly" : undefined}
                    >
                      <span className="shrink-0 text-xs font-mono text-(--text-faint) w-6 text-right">{i + 1}.</span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-(--text-secondary)" title={ch.title}>
                          {ch.title}
                        </span>
                        {ch.translated ? (
                          <span className="block truncate text-xs text-(--text-muted) italic" title={ch.translated}>
                            {ch.translated}
                          </span>
                        ) : null}
                      </span>
                      <span className={`shrink-0 text-xs tabular-nums ${ch.anomaly ? "text-(--warning-text) font-medium" : "text-(--text-muted)"}`}>
                        {pdfFile ? (
                          <button
                            onClick={() => setPdfPreview({ fileId: pdfFile.id, page: ch.pageStart, filename: pdfFile.filename })}
                            className="text-(--accent-text) hover:text-(--accent-text-hover) tabular-nums"
                            title="Open the source PDF at this chapter's first page"
                          >
                            p.{ch.pageStart}–{ch.pageEnd}
                          </button>
                        ) : (
                          <>p.{ch.pageStart}–{ch.pageEnd}</>
                        )}
                        {" · "}{ch.words.toLocaleString()}w
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3 p-4 border-t border-(--border)">
          <Button
            onClick={() => proposeMutation.mutate({ id: bookId, method: "deterministic" })}
            disabled={proposalRunning || proposeMutation.isPending}
            title="Re-run the heading heuristics and preview the result before committing"
          >
            Propose (heuristic)
          </Button>
          <Button
            onClick={() => proposeMutation.mutate({ id: bookId, method: "llm", model })}
            disabled={proposalRunning || proposeMutation.isPending}
            title="Ask the selected AI model to find the table of contents and propose chapter boundaries (takes a few minutes on big or multi-file books)"
          >
            Propose (LLM)
          </Button>
          <ModelPicker value={model} onChange={setModel} testId="structure-chapter-model" />
          {proposalRunning ? (
            <span className="text-sm text-(--accent-text) truncate" data-testid="proposal-running" title={proposalProgress}>
              {proposalProgress?.replace(/^\[AI\]\s*/, "") ??
                `Proposal running${chapterProposal?.method === "llm" ? " (asking the model)" : ""}...`}
            </span>
          ) : null}
          {applyMutation.error || confirmMutation.error || proposeMutation.error ? (
            <span className="text-sm text-(--danger-text) truncate">
              {(applyMutation.error ?? confirmMutation.error ?? proposeMutation.error)?.message}
            </span>
          ) : null}
          <div className="flex-1" />
          <span className="text-sm text-(--text-muted)">{selectedCount} boundaries</span>
          <Button
            variant={confirmed ? "secondary" : "primary"}
            onClick={apply}
            disabled={selectedCount === 0 || isProcessing || applyMutation.isPending || confirmMutation.isPending}
            title={
              selectedCount === 0 ? "Check at least one heading" :
              isProcessing ? "Wait for processing to finish" :
              unchanged ? "The chapters stay as they are — this only records that you looked at them." :
              "Cut the chapters at the checked boundaries — that is the review. Later changes remove the audio those chapters had."
            }
            data-testid="apply-boundaries"
          >
            {unchanged ? "Keep these chapters" : "Apply boundaries"}
          </Button>
        </div>
      </Modal>
      {pdfPreview ? (
        <PdfPreviewModal
          fileId={pdfPreview.fileId}
          page={pdfPreview.page}
          filename={pdfPreview.filename}
          onClose={() => setPdfPreview(null)}
        />
      ) : null}
    </>
  );
}
