import { useState, useRef } from "react";
import { ExtractModal, type ExtractScope } from "./ExtractModal.tsx";
import { PdfPreviewModal } from "./PdfPreviewModal.tsx";

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
  onReExtract,
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
  onSetAllSelected: (selected: boolean) => void;
  onSetSelectedBatch: (ids: string[], selected: boolean) => void;
  onRemove: (id: string) => void;
  onReExtract: (id: string) => void;
  onCancelExtraction: () => void;
  onCancel: (id: string) => void;
  onFilesAdded: () => void;
}) {
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
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
      onSetSelectedBatch(ids, !file.selected);
    } else {
      onSetSelected(file.id, !file.selected);
    }
    setLastClickedIndex(index);
  }

  const extractingCount = files.filter((f) => f.status === "extracting" || f.status === "pending").length;
  const isEmpty = files.length === 0;

  return (
    <section className={`relative overflow-hidden mb-6 rounded-xl border border-(--border) border-t-2 bg-(--bg-card) p-4 ${
      extractingCount > 0 ? "border-t-(--step-work)" : "border-t-(--step-input)"
    }`}>
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
        <button
          onClick={() => onExtractOpenChange(true)}
          disabled={isEmpty}
          title={isEmpty ? "Add a PDF first" : "Extract files again, or re-detect chapter boundaries"}
          className="px-3 py-1.5 bg-(--bg-subtle) text-(--text-secondary) rounded-md text-xs font-medium hover:bg-(--border) disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="open-extract-modal"
        >
          Extract...
        </button>
        <button
          onClick={onCancelExtraction}
          disabled={extractingCount === 0}
          title={
            extractingCount === 0
              ? "No files are being extracted"
              : `Stop the running extraction — ${extractingCount} file(s) will be marked as cancelled`
          }
          className="px-3 py-1.5 bg-(--warning) text-(--on-warning) hover:bg-(--warning-hover) rounded-md text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="cancel-extraction"
        >
          Cancel extraction
        </button>

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
                  onChange={() => onSetAllSelected(!allSelected)}
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
                    <button
                      onClick={() => setPreviewFileId(file.id)}
                      className="shrink-0 h-6 w-6 rounded bg-(--danger-bg) flex items-center justify-center hover:bg-(--danger)/20 transition-colors cursor-pointer"
                      title="Preview PDF"
                    >
                      <span className="text-(--danger-text) text-[8px] font-bold">PDF</span>
                    </button>
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
                    {/* Cancel */}
                    <button
                      onClick={() => onCancel(file.id)}
                      disabled={file.status !== "extracting" && file.status !== "pending"}
                      title={file.status !== "extracting" && file.status !== "pending" ? "File is not extracting" : "Cancel extraction"}
                      className="p-1 rounded text-(--warning-text) hover:bg-(--warning-bg) disabled:opacity-20 disabled:cursor-not-allowed"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM6 6h4v4H6V6z"/>
                      </svg>
                    </button>
                    {/* Re-extract */}
                    <button
                      onClick={() => onReExtract(file.id)}
                      disabled={file.status !== "done" && file.status !== "failed" && file.status !== "raw" && file.status !== "suspended"}
                      title={
                        file.status === "extracting" ? "Wait for extraction to finish" :
                        file.status === "pending" ? "File hasn't been extracted yet" :
                        file.status === "raw" ? "Extract chapters from this file" :
                        "Re-extract this file"
                      }
                      className="p-1 rounded text-(--accent-text) hover:bg-(--bg-selected) disabled:opacity-20 disabled:cursor-not-allowed"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M11.534 7h3.932a.25.25 0 01.192.41l-1.966 2.36a.25.25 0 01-.384 0l-1.966-2.36A.25.25 0 0111.534 7zM.534 9h3.932a.25.25 0 00.192-.41L2.692 6.23a.25.25 0 00-.384 0L.342 8.59A.25.25 0 00.534 9z"/>
                        <path d="M8 3a5 5 0 00-4.546 2.914.5.5 0 01-.908-.418A6 6 0 0114 8a.5.5 0 01-1 0 5 5 0 00-5-5zM2.5 8a.5.5 0 01.5.5A5 5 0 0012.546 11.086a.5.5 0 11.908.418A6 6 0 012 8.5a.5.5 0 01.5-.5z"/>
                      </svg>
                    </button>
                    {/* Remove */}
                    <button
                      onClick={() => {
                        const count = chapterCountForFile(file.index);
                        if (confirm(`Remove "${file.filename}" and its ${count} chapter(s)?`)) {
                          onRemove(file.id);
                        }
                      }}
                      disabled={file.status === "extracting"}
                      title={file.status === "extracting" ? "Cannot remove while extracting" : "Remove this file and its chapters"}
                      className="p-1 rounded text-(--danger-text) hover:bg-(--danger-bg) disabled:opacity-20 disabled:cursor-not-allowed"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M5.75 1a.75.75 0 00-.75.75v.5H2.5a.75.75 0 000 1.5h.31l.69 9.112A1.75 1.75 0 005.246 14.5h5.508a1.75 1.75 0 001.746-1.638L13.19 3.75h.31a.75.75 0 000-1.5H11V1.75a.75.75 0 00-.75-.75h-4.5zM6.5 2.25v-.5h3v.5h-3zM4.32 3.75h7.36l-.68 9.04a.25.25 0 01-.249.21H5.249a.25.25 0 01-.249-.21L4.32 3.75z"/>
                      </svg>
                    </button>
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
    </section>
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
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        className="px-3 py-1.5 bg-(--bg-subtle) text-(--text-secondary) rounded-md text-xs font-medium hover:bg-(--border) disabled:opacity-50"
      >
        {isUploading ? "Adding..." : "Add files"}
      </button>
    </>
  );
}
