import { useState, useRef, useCallback, type DragEvent, type ReactNode } from "react";
import { VoicePicker } from "./VoicePicker.tsx";
import { SpeedSlider } from "./SpeedSlider.tsx";
import { getVoiceById, voiceSupportsSpeedControl, getVoiceLabel } from "../lib/voices.ts";
import { AI_PRESETS } from "../lib/ai-presets.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { PillToggle } from "./PillToggle.tsx";
import { profileHeaders } from "../lib/profile.ts";
import { AfterExtractChoice } from "./AfterExtractChoice.tsx";

type UploadZoneProps = {
  onUploadComplete: () => void;
  folderId?: string | null;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type OptionProps = {
  label: string;
  hint: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  testId?: string;
};

function Option({ label, hint, checked, onChange, title, testId }: OptionProps) {
  return (
    <label className="flex gap-2 cursor-pointer" title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded"
        data-testid={testId}
      />
      <span className="min-w-0">
        <span className="block text-sm text-(--text-primary)">{label}</span>
        <span className="block text-xs text-(--text-muted)">{hint}</span>
      </span>
    </label>
  );
}

export function UploadZone({ onUploadComplete, folderId = null }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [customTitle, setCustomTitle] = useState("");
  const [voice, setVoice] = useState("kokoro:af_heart");
  const [speed, setSpeed] = useState(1.0);
  const [forceOcr, setForceOcr] = useState(false);
  // Raw-text-only is the default: pdftotext lands in seconds, marker takes minutes — extract chapters later from the book page
  const [fullExtract, setFullExtract] = useState(false);
  const [llmChapterDetection, setLlmChapterDetection] = useState(false);
  const [chapterModel, setChapterModel] = useState<string>("");
  const [autoSynthesize, setAutoSynthesize] = useState(false);
  const [separateBooks, setSeparateBooks] = useState(false);
  const [askAi, setAskAi] = useState(false);
  const [notePreset, setNotePreset] = useState<string>("summarize");
  const [notePrompt, setNotePrompt] = useState<string>(AI_PRESETS[0].prompt("book"));
  const [noteModel, setNoteModel] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function stageFiles(fileList: FileList | File[]) {
    const newFiles: File[] = [];
    for (const file of fileList) {
      if (!file.name.toLowerCase().endsWith(".pdf")) continue;
      newFiles.push(file);
    }
    if (newFiles.length === 0) {
      setError("Only PDF files are supported");
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

  function buildFormData(files: File[], title: string | null): FormData {
    const formData = new FormData();
    for (const file of files) {
      formData.append("file", file);
    }
    if (title) formData.append("title", title);
    formData.append("voice", voice);
    formData.append("speed", String(voiceSupportsSpeedControl(voice) ? speed : 1.0));
    formData.append("forceOcr", String(forceOcr));
    formData.append("fullExtract", String(fullExtract));
    formData.append("llmChapterDetection", String(fullExtract && llmChapterDetection));
    if (fullExtract && llmChapterDetection) formData.append("chapterModel", chapterModel);
    formData.append("skipSynthesis", String(!(fullExtract && autoSynthesize)));
    if (folderId) formData.append("folderId", folderId);
    if (askAi && notePrompt.trim()) {
      formData.append("notePrompt", notePrompt.trim());
      formData.append("noteModel", noteModel);
    }
    return formData;
  }

  async function postUpload(formData: FormData) {
    const res = await fetch("/upload", { method: "POST", body: formData, headers: profileHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Upload failed (${res.status})`);
    }
  }

  async function upload() {
    if (stagedFiles.length === 0) return;
    const asSeparateBooks = separateBooks && stagedFiles.length > 1;

    setIsUploading(true);
    setError(null);

    try {
      if (asSeparateBooks) {
        const failures: string[] = [];
        const succeeded = new Set<File>();
        for (const file of stagedFiles) {
          try {
            await postUpload(buildFormData([file], null));
            succeeded.add(file);
          } catch (err) {
            failures.push(`${file.name}: ${err instanceof Error ? err.message : "failed"}`);
          }
        }
        if (failures.length > 0) {
          // Keep only the failed files staged so a retry doesn't duplicate books
          setStagedFiles((prev) => prev.filter((f) => !succeeded.has(f)));
          throw new Error(`${failures.length} of ${stagedFiles.length} uploads failed — ${failures.join("; ")}`);
        }
      } else {
        await postUpload(buildFormData(stagedFiles, customTitle.trim() || null));
      }

      setStagedFiles([]);
      setCustomTitle("");
      onUploadComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      onUploadComplete();
    } finally {
      setIsUploading(false);
    }
  }

  async function readEntryFiles(entry: FileSystemEntry): Promise<File[]> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      return file.name.toLowerCase().endsWith(".pdf") ? [file] : [];
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries: FileSystemEntry[] = [];
      // readEntries returns batches of ≤100; keep reading until an empty batch
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        entries.push(...batch);
      }
      const nested = await Promise.all(entries.map(readEntryFiles));
      return nested.flat();
    }
    return [];
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setIsDragging(false);

    // Entries must be captured synchronously — the DataTransfer is dead after the first await
    const entries = [...e.dataTransfer.items]
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter((entry): entry is FileSystemEntry => entry !== null);

    if (!entries.some((entry) => entry.isDirectory)) {
      if (e.dataTransfer.files.length > 0) stageFiles(e.dataTransfer.files);
      return;
    }

    try {
      const collected = (await Promise.all(entries.map(readEntryFiles))).flat();
      collected.sort((a, b) => a.name.localeCompare(b.name));
      if (collected.length === 0) {
        setError("No PDF files found in the dropped folder");
        return;
      }
      // A folder is usually a collection of separate books, not volumes of one
      if (collected.length > 1 && stagedFiles.length === 0) setSeparateBooks(true);
      stageFiles(collected);
    } catch {
      setError("Could not read the dropped folder");
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
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
  const isMultiFile = stagedFiles.length > 1;
  const isReorderable = isMultiFile && !separateBooks;
  const totalSize = stagedFiles.reduce((sum, file) => sum + file.size, 0);
  const selectedVoice = getVoiceById(voice);
  const speedEnabled = voiceSupportsSpeedControl(voice);
  const noteTarget = isMultiFile && separateBooks ? "each book" : "the whole book";

  const outcome = !fullExtract
    ? "Raw text lands in seconds. Chapters and audio can follow later from the book page."
    : autoSynthesize
      ? "Extraction then narration, both in the background — minutes per book."
      : "Marker reads the whole PDF in the background — minutes per book.";

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
          accept=".pdf"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
        {hasFiles ? (
          <div className="text-left space-y-1" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-3 pb-2 border-b border-(--border)">
              <span className="text-xs font-medium text-(--text-secondary)">
                {stagedFiles.length} PDF{stagedFiles.length === 1 ? "" : "s"} · {formatFileSize(totalSize)}
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
                    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                    </svg>
                  </span>
                )}
                {isMultiFile && (
                  <span className="text-xs font-mono text-(--text-muted) w-5 text-right shrink-0">{index + 1}</span>
                )}
                <span className="shrink-0 h-6 rounded px-1.5 bg-(--danger-bg) flex items-center">
                  <span className="text-(--danger-text) text-[10px] font-bold">PDF</span>
                </span>
                <span className="min-w-0 flex-1 text-sm text-(--text-primary) truncate">{file.name}</span>
                <span className="shrink-0 text-xs text-(--text-muted)">{formatFileSize(file.size)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  title={`Remove ${file.name}`}
                  className="shrink-0 p-1 text-(--text-faint) hover:text-(--text-tertiary) rounded"
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-2 text-xs text-(--text-muted) hover:text-(--text-secondary) border border-dashed border-(--border-input) rounded-md transition-colors"
            >
              + Add more files
            </button>
          </div>
        ) : (
          <div>
            <p className="text-lg font-medium text-(--text-secondary)">Drop PDF files or a folder here</p>
            <p className="text-sm text-(--text-muted) mt-1">or click to browse — folders are scanned recursively for PDFs</p>
          </div>
        )}
      </div>

      {hasFiles && (
        <div className="max-w-3xl rounded-lg border border-(--border) bg-(--bg-card) divide-y divide-(--divide)">
          {isMultiFile && (
            <fieldset className="p-4 space-y-2" data-testid="upload-mode">
              <legend className="text-xs font-medium text-(--text-secondary) mb-1">These {stagedFiles.length} files are</legend>
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
                    placeholder={stagedFiles[0]?.name.replace(/\.pdf$/i, "").replace(/[_-]/g, " ")}
                    className="w-full px-3 py-2 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary) placeholder:text-(--text-faint)"
                  />
                </label>
              )}
            </fieldset>
          )}

          <fieldset className="p-4 space-y-2">
            <legend className="text-xs font-medium text-(--text-secondary) mb-1">Text extraction</legend>

            <Option
              label="Extract chapters now"
              hint="Marker reads the whole PDF — minutes per book. Off, raw text still lands in seconds and chapters can wait."
              title="Raw text is always extracted in seconds. Marker is the slow, layout-aware pass that finds chapter boundaries — you can also run it later from the book page."
              checked={fullExtract}
              onChange={setFullExtract}
              testId="full-extract"
            />

            {fullExtract && (
              <div className="pl-6 space-y-2">
                <Option
                  label="Follow the table of contents"
                  hint="AI takes chapter boundaries from the TOC instead of from headings."
                  checked={llmChapterDetection}
                  onChange={setLlmChapterDetection}
                />
                {llmChapterDetection && (
                  <div className="flex items-center gap-2 pl-6 text-xs text-(--text-muted)">
                    <span>Model</span>
                    <ModelPicker value={chapterModel} onChange={setChapterModel} testId="upload-chapter-model" />
                  </div>
                )}
              </div>
            )}

            <Option
              label="Scanned PDF — needs OCR"
              hint="The pages are images; any text layer the file carries is discarded. Saved on the book, so later extractions use it too."
              title="Also covers a phone photo printed to PDF, where the only selectable text is the print header."
              checked={forceOcr}
              onChange={setForceOcr}
            />
          </fieldset>

          {fullExtract && (
            <div className="p-4 space-y-3">
              <AfterExtractChoice
                autoSynthesize={autoSynthesize}
                onChange={setAutoSynthesize}
                voiceLabel={getVoiceLabel(voice)}
              />
              {autoSynthesize && (
                <div className="pl-6 space-y-1">
                  <div className="flex flex-wrap items-end gap-4">
                    <VoicePicker value={voice} onChange={setVoice} />
                    <SpeedSlider value={speed} onChange={setSpeed} disabled={!speedEnabled} />
                  </div>
                  {!speedEnabled && selectedVoice && (
                    <p className="text-xs text-(--text-muted)">{selectedVoice.label} uses a fixed speed in v1.</p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="p-4 space-y-2">
            <Option
              label="Ask AI after upload"
              hint={`Runs a prompt over the raw text of ${noteTarget} — the answer lands in the book's notes.`}
              checked={askAi}
              onChange={setAskAi}
              testId="upload-ask-ai"
            />

            {askAi && (
              <div className="ml-6 rounded-lg border border-(--border) bg-(--bg-subtle) p-3 space-y-2" data-testid="upload-ai-section">
                <div className="flex flex-wrap gap-1.5">
                  {AI_PRESETS.map((p) => (
                    <PillToggle
                      key={p.key}
                      selected={notePreset === p.key}
                      onClick={() => {
                        setNotePreset(p.key);
                        setNotePrompt(p.prompt("book"));
                      }}
                    >
                      {p.label}
                    </PillToggle>
                  ))}
                </div>
                <textarea
                  value={notePrompt}
                  onChange={(e) => setNotePrompt(e.target.value)}
                  rows={3}
                  maxLength={4000}
                  className="w-full resize-y rounded-md border border-(--border-input) bg-(--bg-card) p-2.5 text-sm text-(--text-primary) leading-relaxed"
                  placeholder={`What should the AI answer about ${noteTarget}?`}
                  data-testid="upload-ai-prompt"
                />
                <div className="flex items-center gap-2 text-xs text-(--text-muted)">
                  <span>Model</span>
                  <ModelPicker value={noteModel} onChange={setNoteModel} testId="upload-note-model" />
                </div>
              </div>
            )}
          </div>

          <div className="p-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={upload}
              disabled={isUploading}
              className="px-5 py-2.5 bg-(--accent) text-(--on-accent) rounded-md text-sm font-medium hover:bg-(--accent-hover) disabled:opacity-50"
            >
              {isUploading ? "Uploading..." : !fullExtract ? "Upload" : autoSynthesize ? "Extract & synthesize" : "Extract"}
              {isMultiFile ? ` (${stagedFiles.length} ${separateBooks ? "books" : "files"})` : ""}
            </button>
            <p className="min-w-0 flex-1 text-xs text-(--text-muted)">{outcome}</p>
          </div>
        </div>
      )}

      {error && (
        <p className="text-(--danger-text) text-sm" role="alert">{error}</p>
      )}
    </div>
  );
}
