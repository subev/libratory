import { useState } from "react";

import { BOOK_LANGUAGE_OPTIONS } from "../lib/languages.ts";
import { trpc } from "../trpc.ts";
import { Modal, ModalHeader } from "./Modal.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { Button } from "./Button.tsx";
import { DEFAULT_OCR_ENGINE, type OcrEngine } from "../lib/ocr.ts";
import { packForBookLanguage, useOcrLanguages } from "../lib/use-ocr-languages.ts";
import { OcrEngineChoice } from "./OcrEngineChoice.tsx";
import { OcrLanguagePackRow } from "./OcrLanguagePackRow.tsx";

export type ExtractScope = "selected" | "book" | "chapters";

// Three toolbar buttons that each destroyed different work read as three equal options. As one
// choice with its consequence spelled out, the destructive one is obvious before you press it.
const SCOPES: { id: ExtractScope; label: string; detail: string }[] = [
  {
    id: "selected",
    label: "Selected files",
    detail: "Re-reads those files. Their chapters, edits and audio are replaced; other files keep theirs.",
  },
  {
    id: "book",
    label: "Entire book",
    detail: "Re-reads every file. All chapters, edits, audio and assemblies are replaced.",
  },
  {
    id: "chapters",
    label: "Chapter boundaries only",
    detail: "Re-splits text that's already extracted — no OCR — but still replaces the chapters, so audio and edits go with them.",
  },
];

export function ExtractModal({
  selectedCount,
  hasChapters,
  chaptersForSelected,
  chaptersTotal,
  isProcessing,
  bookId,
  ocrEngine,
  canSetOcr,
  tryFileIndex,
  scan,
  llmChapterDetection,
  chapterModel,
  language,
  onUpdateBook,
  onStart,
  onClose,
}: {
  selectedCount: number;
  hasChapters: boolean;
  chaptersForSelected: number;
  chaptersTotal: number;
  isProcessing: boolean;
  bookId: string;
  ocrEngine: OcrEngine | null;
  canSetOcr: boolean;
  tryFileIndex: number;
  scan: { read: boolean; engine: OcrEngine | null; confidence: number | null; garbled: boolean };
  llmChapterDetection: boolean;
  chapterModel: string | null;
  language: string | null;
  onUpdateBook: (settings: { ocrEngine?: OcrEngine | null; llmChapterDetection?: boolean; chapterModel?: string; language?: string | null }) => void;
  onStart: (scope: ExtractScope) => void;
  onClose: () => void;
}) {
  const { languages: ocrLanguages } = useOcrLanguages();
  const suggestion = trpc.ocrTry.page.useQuery({ bookId, fileIndex: tryFileIndex, page: 5 }, { enabled: canSetOcr, staleTime: Infinity });
  const suggestedPack = ocrLanguages.find((l) => l.code === (suggestion.data?.candidates ?? [])[0]) ?? null;
  const pack = packForBookLanguage(ocrLanguages, language) ?? (language ? null : suggestedPack);
  const languageLabel = (iso: string) => BOOK_LANGUAGE_OPTIONS.find((o) => o.code === iso)?.label ?? iso;
  const disabledReason = (scope: ExtractScope) => {
    if (isProcessing) return "Wait for the current extraction to finish";
    if (scope === "selected" && selectedCount === 0) return "Select files first";
    if (scope !== "selected" && !hasChapters) return "Nothing extracted yet";
    return null;
  };

  const [scope, setScope] = useState<ExtractScope>(() =>
    selectedCount > 0 ? "selected" : hasChapters ? "chapters" : "selected",
  );
  // Every scope replaces chapters — and with them any edits, audio and assemblies. Spelling the
  // count out and requiring a tick is the difference between reading a warning and acting on it.
  const losing = scope === "selected" ? chaptersForSelected : chaptersTotal;
  // The tick is against one scope's count, so changing the scope withdraws it
  const [confirmedScope, setConfirmedScope] = useState<ExtractScope | null>(null);
  const confirmed = confirmedScope === scope;
  const blocked = disabledReason(scope) ?? (losing > 0 && !confirmed ? "Confirm the chapters you're replacing" : null);
  const usingTesseract = (ocrEngine ?? DEFAULT_OCR_ENGINE) === DEFAULT_OCR_ENGINE;

  return (
    <Modal size="md" onClose={onClose} testId="extract-modal">
      <ModalHeader title={hasChapters ? "Extract" : "Extract chapters"} onClose={onClose} />

      <div className="p-4 space-y-4 overflow-y-auto">
        {hasChapters ? (
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-(--text-secondary) mb-1">What to redo</legend>
            {SCOPES.map((entry) => {
              const reason = disabledReason(entry.id);
              const label = entry.id === "selected" ? `${entry.label} (${selectedCount})` : entry.label;
              return (
                <label
                  key={entry.id}
                  title={reason ?? undefined}
                  className={`flex gap-2 rounded-md border p-2 ${ scope === entry.id ? "border-(--accent) bg-(--bg-selected)" : "border-(--border)" } ${reason ? "opacity-50" : "cursor-pointer hover:bg-(--bg-subtle)"}`}
                >
                  <input
                    type="radio"
                    name="extract-scope"
                    checked={scope === entry.id}
                    disabled={!!reason}
                    onChange={() => setScope(entry.id)}
                    className="mt-0.5"
                    data-testid={`extract-scope-${entry.id}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-(--text-primary)">{label}</span>
                    <span className="block text-xs text-(--text-muted)">{entry.detail}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : (
          <p className="text-sm text-(--text-secondary)" data-testid="extract-first-run">
            {selectedCount === 0
              ? "No files are selected, so there is nothing to read. Close this and tick the files you want in the list above."
              : `The app reads ${selectedCount === 1 ? "the selected file" : `the ${selectedCount} selected files`} and finds the chapter boundaries — minutes per book. Nothing is replaced: this book has no chapters yet.`}
          </p>
        )}

        {canSetOcr && (
          <div className="space-y-2 border-t border-(--border) pt-3">
            <OcrEngineChoice
              value={ocrEngine}
              used={scan.engine}
              onChange={(engine) => onUpdateBook({ ocrEngine: engine })}
              tryHref={`/books/${bookId}/ocr?file=${tryFileIndex}`}
              status={scan.read
                ? scan.garbled
                  ? <><strong className="text-(--warning-text)">Tesseract struggled here.</strong> It read the pages in the background but doubted many of its words — the sign of photographed, curled or faded pages. That is what Surya is for: pick it below, and the pages are read again.</>
                  : <><strong className="text-(--success-text)">Already done.</strong> The pages are pictures, and {scan.engine === "surya" ? "Surya" : scan.engine === "tesseract" ? "Tesseract" : "Tesseract and Surya between them"} read them in the background{scan.confidence !== null ? `, ${Math.round(scan.confidence * 100)}% sure of its words` : ""} — a good result. Keep it. Only switch if the text you see looks wrong, which happens with photographed, curled or faded pages.</>
                : isProcessing
                  ? "The pages are pictures. They are being read in the background right now; extraction picks up the result."
                  : "The pages are pictures. Extraction reads them first, with the engine below, into a copy kept beside the original."}
              note={usingTesseract
                ? suggestion.isLoading ? "Looking at a page for its alphabet…"
                  : language ? `Read as ${languageLabel(language)}, the book's language.`
                  : suggestion.data?.script && suggestedPack ? `${suggestion.data.script} letters on page ${suggestion.data.page} — read as ${suggestedPack.name} unless the language below says otherwise.`
                  : "Read as English unless the language below says otherwise."
                : undefined}
            />
            {usingTesseract && pack && <OcrLanguagePackRow code={pack.code} />}
          </div>
        )}

        <div className="space-y-2 border-t border-(--border) pt-3">
          <label className="flex gap-2 text-xs text-(--text-muted)">
            <input
              type="checkbox"
              checked={llmChapterDetection}
              onChange={(e) => onUpdateBook({ llmChapterDetection: e.target.checked })}
              className="mt-0.5 rounded"
            />
            <span>
              <span className="block text-(--text-secondary)">This book has a table of contents worth following</span>
              The AI reads it to place the chapter boundaries. Off, the boundaries come from the headings on the pages.
            </span>
          </label>
          {llmChapterDetection && (
            <div className="flex items-center gap-2 pl-6 text-xs text-(--text-muted)">
              <span>Model</span>
              <ModelPicker
                value={chapterModel ?? ""}
                onChange={(key) => onUpdateBook({ chapterModel: key })}
                testId="extract-chapter-model"
              />
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-(--border) pt-3">
          <label className="flex items-center gap-2 text-xs text-(--text-muted)">
            <span className="text-(--text-secondary) w-28 shrink-0">Language</span>
            <select
              value={language ?? ""}
              onChange={(e) => onUpdateBook({ language: e.target.value || null })}
              className="rounded border border-(--border-input) bg-(--bg-input) px-1.5 py-1 text-xs"
              data-testid="book-language"
            >
              <option value="">Not set</option>
              {BOOK_LANGUAGE_OPTIONS.map(({ code, label }) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
            <span className="min-w-0">Which voices come first, and how pictured pages are read. Filled from the text; change it if wrong.</span>
          </label>
          <p className="text-xs text-(--text-faint)">Saved on the book as you change them.</p>
        </div>
      </div>

      {losing > 0 && (
        <label className="mx-4 mb-3 flex gap-2 rounded-md border border-(--warning) bg-(--warning-bg) p-2.5 text-xs text-(--warning-text) cursor-pointer">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmedScope(e.target.checked ? scope : null)}
            className="mt-0.5 rounded"
            data-testid="extract-confirm"
          />
          <span>
            This replaces <strong>{losing} chapter{losing === 1 ? "" : "s"}</strong>, along with their synthesized
            audio and any text you've edited. It can't be undone.
          </span>
        </label>
      )}

      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-(--border)">
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="primary"
          onClick={() => onStart(scope)}
          disabled={!!blocked}
          title={blocked ?? undefined}
          data-testid="extract-start"
        >
          {scope === "chapters" ? "Re-detect chapters" : scope === "book" ? "Extract whole book" : `Extract ${selectedCount} file${selectedCount === 1 ? "" : "s"}`}
        </Button>
      </div>
    </Modal>
  );
}
