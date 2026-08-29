import { useState, useRef } from "react";
import { ExtractModal, type ExtractScope } from "./ExtractModal.tsx";
import { PdfPreviewModal } from "./PdfPreviewModal.tsx";
import { IconStop, IconRefresh, IconDelete } from "./icons.tsx";
import { Button } from "./Button.tsx";
import { Section } from "./Section.tsx";

export type BookFileRow = {
  id: string;
  index: number;
  filename: string;
  status: string;
  selected: boolean;
  skipSynthesis: boolean;
  rawWords?: number | null;
  error: string | null;
};

type ChapterRowForFiles = {
  sourceFileIndex: number | null;
  [key: string]: unknown;
};

export function BookFilesSection({
  files,
  chapters,
  bookId,
  isProcessing,
  forceOcr,
  llmChapterDetection,
  chapterModel,
  language,
  voiceLabel,
  extractOpen,
  onExtractOpenChange,
  onStartExtraction,
  onUpdateExtractionSettings,
  onSetSelected,
  onSetAllSelected,
  onSetSelectedBatch,
  onRemove,
  onCancelExtraction,
  onCancel,
  onFilesAdded,
}: {
  files: BookFileRow[];
  chapters: ChapterRowForFiles[];
  bookId: string;
  isProcessing: boolean;
  forceOcr: boolean;
  llmChapterDetection: boolean;
  chapterModel: string | null;
  language: string | null;
  voiceLabel: string;
  extractOpen: boolean;
  onExtractOpenChange: (open: boolean) => void;
  onStartExtraction: (scope: ExtractScope, autoSynthesize: boolean) => void;
  onUpdateExtractionSettings: (settings: { forceOcr?: boolean; llmChapterDetection?: boolean; chapterModel?: string; language?: string | null }) => void;
  onSetSelected: (id: string, selected: boolean) => void;
  onSetAllSelected: (selected: boolean) => void | Promise<unknown>;
  onSetSelectedBatch: (ids: string[], selected: boolean) => void | Promise<unknown>;
  onRemove: (id: string) => void;
  onCancelExtraction: () => void;
  onCancel: (id: string) => void;
  onFilesAdded: () => void;
}) {
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  // Selection is fire-and-forget from the checkboxes; the banner reports a failure, this only
  // stops an unhandled rejection now that the handlers return a promise.
  const detach = (result: void | Promise<unknown>) => void Promise.resolve(result).catch(() => {});
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);

  // Chapters belonging to the currently selected files — what a scoped re-extract would replace.
  const selectedFileIndexes = new Set(files.filter((f) => f.selected).map((f) => f.index));
  const chaptersForSelected = chapters.filter(
    (c) => typeof c.sourceFileIndex === "number" && selectedFileIndexes.has(c.sourceFileIndex),
  ).length;

  const selectedCount = files.filter((f) => f.selected).length;
  const allSelected = files.length > 0 && selectedCount === files.length;
  const noneSelected = selectedCount === 0;

  function chapterCountForFile(fileIndex: number) {
    return chapters.filter((ch) => ch.sourceFileIndex === fileIndex).length;
  }

  function handleCheckboxClick(file: BookFileRow, index: number, e: React.MouseEvent) {
    if (e.shiftKey && lastClickedIndex !== null) {
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      const ids = files.slice(start, end + 1).map((f) => f.id);
      detach(onSetSelectedBatch(ids, !file.selected));
    } else {
      onSetSelected(file.id, !file.selected);
    }
    setLastClickedIndex(index);
  }

  const extractingCount = files.filter((f) => f.status === "extracting" || f.status === "pending").length;
  const isEmpty = files.length === 0;

  return (
    <Section stripe={extractingCount > 0 ? "work" : "input"} className="relative overflow-hidden mb-6">
      {extractingCount > 0 && (
        <>
          <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden" aria-hidden>
            <div className="h-full w-1/4 bg-(--accent) animate-[slide-indeterminate_1.4s_ease-in-out_infinite]" />
          </div>
          <div className="absolute inset-0 rounded-xl ring-2 ring-inset ring-(--accent)/30 animate-pulse pointer-events-none" aria-hidden />
        </>
      )}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-(--text-secondary)">
            <span className="text-xs font-medium text-(--warning-text) uppercase tracking-wider mr-2">1 · Input</span>
            Source files
          </h2>
          {extractingCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-(--accent-text)" data-testid="extracting-indicator">
              <span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse" />
              Extracting {extractingCount} file{extractingCount === 1 ? "" : "s"}...
            </span>
          )}
        </div>
        <span className="text-sm text-(--text-muted)">{selectedCount} of {files.length} selected</span>
      </div>

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <AddFilesButton bookId={bookId} onFilesAdded={onFilesAdded} />
        <Button
          size="sm"
          onClick={() => onExtractOpenChange(true)}
          disabled={isEmpty}
          title={isEmpty ? "Add a PDF first" : "Extract files again, or re-detect chapter boundaries"}
          data-testid="open-extract-modal"
        >
          Extract...
        </Button>
        {extractingCount > 0 && (
          <Button
            variant="warning"
            size="sm"
            onClick={onCancelExtraction}
            title={`Stop the running extraction — ${extractingCount} file(s) will be marked as cancelled`}
            data-testid="cancel-extraction"
          >
            Cancel extraction
          </Button>
        )}

      </div>

      <div className="overflow-x-auto rounded-lg border border-(--border)">
        <table className="w-full min-w-[48rem] divide-y divide-(--divide)">
          <thead className="bg-(--bg-subtle)">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = !allSelected && !noneSelected; }}
                  onChange={() => detach(onSetAllSelected(!allSelected))}
                  disabled={isEmpty}
                  className="rounded disabled:opacity-40"
                />
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-(--text-muted) uppercase">#</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-(--text-muted) uppercase">Filename</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-(--text-muted) uppercase">Status</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-(--text-muted) uppercase">Chapters</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-(--text-muted) uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-(--bg-card) divide-y divide-(--divide)">
            {files.map((file, i) => (
              <tr key={file.id} className="hover:bg-(--bg-card-hover)">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={file.selected}
                    onClick={(e) => handleCheckboxClick(file, i, e)}
                    readOnly
                    className="rounded"
                  />
                </td>
                <td className="px-3 py-2 text-xs font-mono text-(--text-muted)">{file.index + 1}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {/* Neutral, not red: red is destructive in this row, and Remove is four cells away */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setPreviewFileId(file.id)}
                      className="shrink-0"
                      title="Preview PDF"
                    >
                      PDF
                    </Button>
                    <span className="text-sm text-(--text-primary) truncate">{file.filename}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className={`text-xs font-medium ${
                    file.status === "done" ? "text-(--success-text)" :
                    file.status === "failed" ? "text-(--danger-text)" :
                    file.status === "suspended" ? "text-(--warning-text)" :
                    file.status === "extracting" ? "text-(--accent-text)" :
                    "text-(--text-muted)"
                  }`}>
                    {file.status === "raw" ? "raw text" : file.status === "suspended" ? "cancelled" : file.status}
                    {file.status === "extracting" && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-(--accent) ml-1.5 animate-pulse" />
                    )}
                  </span>
                  {file.rawWords != null && file.status === "raw" && (
                    <span className="ml-2 text-xs text-(--text-faint)" title="Words in the raw text layer">
                      {file.rawWords.toLocaleString()} words
                    </span>
                  )}
                  {/* Thirty characters cut "marker_single could not be run (exit 126) — the Python
                      environment looks broken" down to the half that says nothing. */}
                  {file.error && (
                    <span className="mt-0.5 text-xs text-(--danger-text) wrap-break-word line-clamp-2" title={file.error}>
                      {file.error}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-sm tabular-nums text-(--text-tertiary)">
                  {chapterCountForFile(file.index)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {/* Cancelling acts on a running job, not on the file — with no job there is
                        nothing to disable, so this one appears rather than greying out. */}
                    {(file.status === "extracting" || file.status === "pending") && (
                      <Button
                        variant="warning"
                        soft
                        size="sm"
                        onClick={() => onCancel(file.id)}
                        title="Cancel extraction"
                        aria-label="Cancel extraction"
                      >
                        <IconStop className="w-4 h-4" />
                      </Button>
                    )}
                    {/* Re-extract */}
                    <Button
                      variant="primary"
                      soft
                      size="sm"
                      onClick={async () => {
                        try {
                          await onSetAllSelected(false);
                          await onSetSelectedBatch([file.id], true);
                        } catch {
                          return; // The extraction banner is already showing it
                        }
                        onExtractOpenChange(true);
                      }}
                      disabled={file.status !== "done" && file.status !== "failed" && file.status !== "raw" && file.status !== "suspended"}
                      title={
                        file.status === "extracting" ? "Wait for extraction to finish" :
                        file.status === "pending" ? "File hasn't been extracted yet" :
                        file.status === "raw" ? "Extract chapters from this file" :
                        "Re-extract this file — opens the extract dialog with only this file selected"
                      }
                      aria-label="Re-extract this file"
                    >
                      <IconRefresh className="w-4 h-4" />
                    </Button>
                    {/* Remove */}
                    <Button
                      variant="danger"
                      soft
                      size="sm"
                      onClick={() => {
                        const count = chapterCountForFile(file.index);
                        if (confirm(`Remove "${file.filename}" and its ${count} chapter(s)?`)) {
                          onRemove(file.id);
                        }
                      }}
                      disabled={file.status === "extracting"}
                      title={file.status === "extracting" ? "Cannot remove while extracting" : "Remove this file and its chapters"}
                      aria-label="Remove this file and its chapters"
                    >
                      <IconDelete className="w-4 h-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {isEmpty && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-(--text-muted)" data-testid="no-source-files">
                  No source files. Use <span className="font-medium text-(--text-secondary)">Add files</span> to upload a PDF.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {extractOpen && (
        <ExtractModal
          selectedCount={selectedCount}
          hasChapters={chapters.length > 0}
          chaptersForSelected={chaptersForSelected}
          chaptersTotal={chapters.length}
          isProcessing={isProcessing}
          forceOcr={forceOcr}
          llmChapterDetection={llmChapterDetection}
          chapterModel={chapterModel}
          language={language}
          voiceLabel={voiceLabel}
          onUpdateBook={onUpdateExtractionSettings}
          onClose={() => onExtractOpenChange(false)}
          onStart={(scope: ExtractScope, autoSynthesize: boolean) => {
            onExtractOpenChange(false);
            onStartExtraction(scope, autoSynthesize);
          }}
        />
      )}

      {previewFileId && (
        <PdfPreviewModal
          fileId={previewFileId}
          filename={files.find((f) => f.id === previewFileId)?.filename}
          onClose={() => setPreviewFileId(null)}
        />
      )}
    </Section>
  );
}

function AddFilesButton({
  bookId,
  onFilesAdded,
}: {
  bookId: string;
  onFilesAdded: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleFiles(fileList: FileList) {
    const pdfs = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (pdfs.length === 0) return;

    setIsUploading(true);
    try {
      const formData = new FormData();
      for (const file of pdfs) {
        formData.append("file", file);
      }
      const res = await fetch(`/upload/${bookId}`, { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }
      onFilesAdded();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        multiple
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleFiles(e.target.files);
          }
          e.target.value = "";
        }}
        className="hidden"
      />
      <Button
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
      >
        {isUploading ? "Adding..." : "Add files"}
      </Button>
    </>
  );
}
