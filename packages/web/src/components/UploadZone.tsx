import { useState, useRef, useCallback, useEffect, type DragEvent } from "react";
import { useNavigate } from "react-router";
import { captureDrop, type DroppedItems, isEpubFile, isPdfFile, readEntryFiles } from "../lib/dnd.ts";
import { profileHeaders } from "../lib/profile.ts";
import { IconDragHandle, IconClose, IconAdd } from "./icons.tsx";
import { Button } from "./Button.tsx";

type UploadZoneProps = {
  /** ok=false means the staged files are still there with an error to read — do not dismiss. */
  onUploadComplete: (ok: boolean) => void;
  /** A drop that landed on the library behind this dialog, handed over to be staged here. */
  initialDrop?: DroppedItems | null;
  folderId?: string | null;
};

const isBookFile = (file: File) => isPdfFile(file) || isEpubFile(file);

function countFiles(pdfs: number, epubs: number): string {
  const parts = [
    pdfs > 0 ? `${pdfs} PDF${pdfs === 1 ? "" : "s"}` : null,
    epubs > 0 ? `${epubs} EPUB${epubs === 1 ? "" : "s"}` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

// One upload request and the book it makes: PDFs may be joined into one book, an EPUB is always its own
type UploadJob = { files: File[]; title: string | null; ebook: boolean };

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}



export function UploadZone({ onUploadComplete, folderId = null, initialDrop = null }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [customTitle, setCustomTitle] = useState("");
  const [separateBooks, setSeparateBooks] = useState(false);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function stageFiles(fileList: FileList | File[]) {
    const newFiles: File[] = [];
    for (const file of fileList) {
      if (!isBookFile(file)) continue;
      newFiles.push(file);
    }
    if (newFiles.length === 0) {
      setError("Only PDF and EPUB files are supported");
      return;
    }
    setError(null);
    setStagedFiles((prev) => [...prev, ...newFiles]);
  }

  function removeFile(index: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  const moveFile = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setStagedFiles((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return prev;
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  function buildFormData({ files, title, ebook }: UploadJob): FormData {
    const formData = new FormData();
    for (const file of files) {
      formData.append("file", file);
    }
    if (title) formData.append("title", title);
    if (folderId) formData.append("folderId", folderId);
    if (!ebook) {
      formData.append("fullExtract", "false");
      formData.append("skipSynthesis", "true");
    }
    return formData;
  }

  async function postUpload(job: UploadJob): Promise<string> {
    const res = await fetch(job.ebook ? "/upload/ebook" : "/upload", { method: "POST", body: buildFormData(job), headers: profileHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Upload failed (${res.status})`);
    }
    return ((await res.json()) as { id: string }).id;
  }

  async function upload() {
    if (stagedFiles.length === 0) return;
    const pdfs = stagedFiles.filter(isPdfFile);
    const jobs: UploadJob[] = [
      ...(separateBooks && pdfs.length > 1
        ? pdfs.map((file) => ({ files: [file], title: null, ebook: false }))
        : pdfs.length > 0 ? [{ files: pdfs, title: customTitle.trim() || null, ebook: false }] : []),
      ...stagedFiles.filter(isEpubFile).map((file) => ({ files: [file], title: null, ebook: true })),
    ];

    setIsUploading(true);
    setError(null);

    try {
      const created: { id: string; ebook: boolean }[] = [];
      if (jobs.length === 1 && jobs[0]) {
        created.push({ id: await postUpload(jobs[0]), ebook: jobs[0].ebook });
      } else {
        const failures: string[] = [];
        const succeeded = new Set<File>();
        for (const job of jobs) {
          try {
            created.push({ id: await postUpload(job), ebook: job.ebook });
            for (const file of job.files) succeeded.add(file);
          } catch (err) {
            failures.push(`${job.files.map((f) => f.name).join(", ")}: ${err instanceof Error ? err.message : "failed"}`);
          }
        }
        if (failures.length > 0) {
          // Keep only the failed files staged so a retry doesn't duplicate books
          setStagedFiles((prev) => prev.filter((f) => !succeeded.has(f)));
          throw new Error(`${failures.length} of ${jobs.length} uploads failed — ${failures.join("; ")}`);
        }
      }

      setStagedFiles([]);
      setCustomTitle("");
      onUploadComplete(true);
      // The book page is where every decision lives — engine, language, chapters — so the dialog asks
      // none of them. An EPUB arrives with its chapters, so there is no extraction to open.
      const [first] = created;
      if (first) navigate(first.ebook ? `/books/${first.id}` : `/books/${first.id}?extract=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      onUploadComplete(false);
    } finally {
      setIsUploading(false);
    }
  }

  async function ingest({ entries, files }: DroppedItems) {
    if (!entries.some((entry) => entry.isDirectory)) {
      if (files.length > 0) stageFiles(files);
      return;
    }

    try {
      const collected = (await Promise.all(entries.map((entry) => readEntryFiles(entry, isBookFile)))).flat();
      collected.sort((a, b) => a.name.localeCompare(b.name));
      if (collected.length === 0) {
        setError("No PDF or EPUB files found in the dropped folder");
        return;
      }
      // A folder is usually a collection of separate books, not volumes of one
      if (collected.length > 1 && stagedFiles.length === 0) setSeparateBooks(true);
      stageFiles(collected);
    } catch {
      setError("Could not read the dropped folder");
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    // The library pane is this dialog's React parent even though the portal puts it elsewhere in the
    // DOM, and synthetic events climb the React tree — without this the pane catches the same drop
    // and hands it back, staging every file twice.
    e.stopPropagation();
    setIsDragging(false);
    void ingest(captureDrop(e));
  }

  // A drop the library caught on our behalf: the same path, one frame later. Keyed on the batch
  // itself rather than on the effect running once — StrictMode invokes it twice, and staging
  // appends, so "runs once" is not something an effect is allowed to assume.
  const ingested = useRef<DroppedItems | null>(null);
  useEffect(() => {
    if (!initialDrop || ingested.current === initialDrop) return;
    ingested.current = initialDrop;
    void ingest(initialDrop);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one shot per dropped batch
  }, [initialDrop]);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      stageFiles(e.target.files);
    }
    e.target.value = "";
  }

  function handleRowDragStart(e: React.DragEvent, index: number) {
    e.dataTransfer.effectAllowed = "move";
    setDragIndex(index);
  }

  function handleRowDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  }

  function handleRowDrop(e: React.DragEvent, toIndex: number) {
    e.preventDefault();
    if (dragIndex !== null) {
      moveFile(dragIndex, toIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }

  function handleRowDragEnd() {
    setDragIndex(null);
    setDragOverIndex(null);
  }

  const hasFiles = stagedFiles.length > 0;
  const pdfCount = stagedFiles.filter(isPdfFile).length;
  const epubCount = stagedFiles.length - pdfCount;
  // The one-or-many choice and the volume order are about PDFs; an EPUB is a whole book on its own
  const isMultiFile = pdfCount > 1;
  const isReorderable = isMultiFile && !separateBooks;
  const bookCount = epubCount + (pdfCount === 0 ? 0 : separateBooks && isMultiFile ? pdfCount : 1);
  const totalSize = stagedFiles.reduce((sum, file) => sum + file.size, 0);


  return (
    <div className="space-y-4">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        className={` border-2 border-dashed rounded-lg text-center transition-colors ${hasFiles ? "p-3" : "p-12"} ${isDragging ? "border-(--accent) bg-(--bg-drag)" : hasFiles ? "border-(--border-input) bg-(--bg-card)" : "border-(--border-input) hover:border-(--text-faint) bg-(--bg-subtle)"} ${isUploading ? "opacity-50 pointer-events-none" : "cursor-pointer"} `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.epub"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
        {hasFiles ? (
          <div className="text-left space-y-1" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-3 pb-2 border-b border-(--border)">
              <span className="text-xs font-medium text-(--text-secondary)">
                {countFiles(pdfCount, epubCount)} · {formatFileSize(totalSize)}
              </span>
              {isReorderable && <span className="text-xs text-(--text-faint)">drag to set the volume order</span>}
              <button
                type="button"
                onClick={() => setStagedFiles([])}
                className="ml-auto text-xs text-(--text-muted) hover:text-(--text-secondary)"
              >
                Clear
              </button>
            </div>
            {stagedFiles.map((file, index) => (
              <div
                key={`${file.name}-${file.size}-${index}`}
                draggable={isReorderable}
                onDragStart={(e) => handleRowDragStart(e, index)}
                onDragOver={(e) => handleRowDragOver(e, index)}
                onDrop={(e) => handleRowDrop(e, index)}
                onDragEnd={handleRowDragEnd}
                className={` flex items-center gap-3 px-3 py-1.5 rounded-md transition-colors ${dragIndex === index ? "opacity-40" : ""} ${dragOverIndex === index && dragIndex !== index ? "bg-(--bg-drag) border border-(--accent) border-dashed" : "hover:bg-(--bg-subtle)"} `}
              >
                {isReorderable && (
                  <span className="cursor-grab text-(--text-faint) select-none" title="Drag to reorder">
                    <IconDragHandle className="h-4 w-4" />
                  </span>
                )}
                {isMultiFile && (
                  <span className="text-xs font-mono text-(--text-muted) w-5 text-right shrink-0">{index + 1}</span>
                )}
                {isEpubFile(file) ? (
                  <span className="shrink-0 h-6 rounded px-1.5 bg-(--success-bg) flex items-center">
                    <span className="text-(--success-text) text-[10px] font-bold">EPUB</span>
                  </span>
                ) : (
                  <span className="shrink-0 h-6 rounded px-1.5 bg-(--danger-bg) flex items-center">
                    <span className="text-(--danger-text) text-[10px] font-bold">PDF</span>
                  </span>
                )}
                <span className="min-w-0 flex-1 text-sm text-(--text-primary) truncate">{file.name}</span>
                <span className="shrink-0 text-xs text-(--text-muted)">{formatFileSize(file.size)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  title={`Remove ${file.name}`}
                  className="shrink-0 p-1 text-(--text-faint) hover:text-(--text-tertiary) rounded"
                >
                  <IconClose className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="w-full border-dashed"
            >
              <IconAdd className="h-3 w-3" /> Add more files
            </Button>
          </div>
        ) : (
          <div>
            <p className="text-lg font-medium text-(--text-secondary)">Drop PDF or EPUB files, or a folder, here</p>
            <p className="text-sm text-(--text-muted) mt-1">or click to browse — folders are scanned recursively for PDFs and EPUBs</p>
          </div>
        )}
      </div>

      {hasFiles && (
        <div className="rounded-lg border border-(--border) bg-(--bg-card) divide-y divide-(--divide)">
          {isMultiFile && (
            <fieldset className="p-4 space-y-2" data-testid="upload-mode">
              <legend className="text-xs font-medium text-(--text-secondary) mb-1">These {pdfCount} PDFs are</legend>
              {[
                { separate: false, label: "One book", detail: "Volumes of a single title, joined in the order above." },
                { separate: true, label: "Separate books", detail: "Each PDF becomes its own book, titled after its filename." },
              ].map((entry) => (
                <label
                  key={entry.label}
                  className={`flex gap-2 rounded-md border p-2 cursor-pointer ${ separateBooks === entry.separate ? "border-(--accent) bg-(--bg-selected)" : "border-(--border) hover:bg-(--bg-subtle)" }`}
                >
                  <input
                    type="radio"
                    name="upload-mode"
                    checked={separateBooks === entry.separate}
                    onChange={() => setSeparateBooks(entry.separate)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-(--text-primary)">{entry.label}</span>
                    <span className="block text-xs text-(--text-muted)">{entry.detail}</span>
                  </span>
                </label>
              ))}

              {!separateBooks && (
                <label className="block pt-1">
                  <span className="block text-xs font-medium text-(--text-secondary) mb-1">Book title</span>
                  <input
                    type="text"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder={stagedFiles.find(isPdfFile)?.name.replace(/\.pdf$/i, "").replace(/[_-]/g, " ")}
                    className="w-full px-3 py-2 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) placeholder:text-(--text-faint)"
                  />
                </label>
              )}
            </fieldset>
          )}

          <div className="p-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              variant="primary"
              onClick={upload}
              disabled={isUploading}
            >
              {isUploading ? "Uploading..." : bookCount > 1 ? `Upload and create ${bookCount} books` : "Upload and create a book"}
              {bookCount === 1 && isMultiFile ? ` (${pdfCount} files)` : ""}
            </Button>
            <p className="min-w-0 flex-1 text-xs text-(--text-muted)">
              {pdfCount > 0
                ? "Raw text lands in seconds. You land on the book, where chapters, OCR and voices are decided."
                : "Chapters come from the EPUB's table of contents. You land on the book, ready to pick a voice."}
            </p>
          </div>
        </div>
      )}

      {error && (
        <p className="text-(--danger-text) text-sm" role="alert">{error}</p>
      )}
    </div>
  );
}
