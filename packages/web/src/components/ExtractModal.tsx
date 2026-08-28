import { useEffect, useState } from "react";

import { AfterExtractChoice } from "./AfterExtractChoice.tsx";
import { BOOK_LANGUAGE_OPTIONS } from "../lib/languages.ts";
import { useBodyScrollLock } from "../lib/use-body-scroll-lock.ts";
import { ModelPicker } from "./ModelPicker.tsx";

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
  forceOcr,
  llmChapterDetection,
  chapterModel,
  language,
  voiceLabel,
  onUpdateBook,
  onStart,
  onClose,
}: {
  selectedCount: number;
  hasChapters: boolean;
  chaptersForSelected: number;
  chaptersTotal: number;
  isProcessing: boolean;
  forceOcr: boolean;
  llmChapterDetection: boolean;
  chapterModel: string | null;
  language: string | null;
  voiceLabel: string;
  onUpdateBook: (settings: { forceOcr?: boolean; llmChapterDetection?: boolean; chapterModel?: string; language?: string | null }) => void;
  onStart: (scope: ExtractScope, autoSynthesize: boolean) => void;
  onClose: () => void;
}) {
  useBodyScrollLock();

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
  const [confirmed, setConfirmed] = useState(false);
  const [autoSynthesize, setAutoSynthesize] = useState(false);
  useEffect(() => setConfirmed(false), [scope]);
  const blocked = disabledReason(scope) ?? (losing > 0 && !confirmed ? "Confirm the chapters you're replacing" : null);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="extract-modal-title"
        className="bg-(--bg-card) rounded-lg shadow-xl w-[90vw] max-w-lg flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="extract-modal"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-(--border)">
          <h2 id="extract-modal-title" className="text-sm font-medium text-(--text-primary)">{hasChapters ? "Extract" : "Extract chapters"}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-(--text-faint) hover:text-(--text-tertiary) p-1 rounded focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            title="Close"
            aria-label="Close"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
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
                    className={`flex gap-2 rounded-md border p-2 ${
                      scope === entry.id ? "border-blue-500 bg-(--bg-selected)" : "border-(--border)"
                    } ${reason ? "opacity-50" : "cursor-pointer hover:bg-(--bg-subtle)"}`}
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
                : `Marker reads ${selectedCount === 1 ? "the selected file" : `the ${selectedCount} selected files`} and finds the chapter boundaries — minutes per book. Nothing is replaced: this book has no chapters yet.`}
            </p>
          )}

          <div className="border-t border-(--border) pt-3">
            <AfterExtractChoice
              autoSynthesize={autoSynthesize}
              onChange={setAutoSynthesize}
              voiceLabel={voiceLabel}
              chapterCount={scope === "selected" ? chaptersForSelected || undefined : chaptersTotal || undefined}
            />
          </div>

          <div className="space-y-2 border-t border-(--border) pt-3">
            {/* Not app preferences — these describe the source and its text, and outlive any one run. */}
            <p className="text-xs font-medium text-(--text-secondary)">
              About this book <span className="font-normal text-(--text-faint)">— saved as you change them, and used by every extraction</span>
            </p>

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
              <span className="min-w-0">Decides which voices the picker offers first.</span>
            </label>

            <label className="flex gap-2 text-xs text-(--text-muted)">
              <input
                type="checkbox"
                checked={forceOcr}
                onChange={(e) => onUpdateBook({ forceOcr: e.target.checked })}
                className="mt-0.5 rounded"
              />
              <span>
                <span className="block text-(--text-secondary)">Scanned PDF — needs OCR</span>
                Set this when the pages are images. Whatever text layer the file carries is discarded and the pages
                are read afresh — a phone photo printed to PDF brings its print headers along, and those are enough
                to look like text. Much slower; the original PDF is untouched.
              </span>
            </label>

            <label className="flex gap-2 text-xs text-(--text-muted)">
              <input
                type="checkbox"
                checked={llmChapterDetection}
                onChange={(e) => onUpdateBook({ llmChapterDetection: e.target.checked })}
                className="mt-0.5 rounded"
              />
              <span>
                <span className="block text-(--text-secondary)">Has a table of contents worth following</span>
                Uses AI to take chapter boundaries from the TOC. Without it, boundaries come from headings.
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

            <p className="text-xs text-(--text-faint)">Saved on the book — every extraction from now on uses them.</p>
          </div>
        </div>

        {losing > 0 && (
          <label className="mx-4 mb-3 flex gap-2 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-2.5 text-xs text-amber-900 dark:text-amber-200 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
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
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md text-sm font-medium border border-(--border-input) text-(--text-secondary) hover:bg-(--bg-subtle) focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => onStart(scope, autoSynthesize)}
            disabled={!!blocked}
            title={blocked ?? undefined}
            className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            data-testid="extract-start"
          >
            {scope === "chapters" ? "Re-detect chapters" : scope === "book" ? "Extract whole book" : `Extract ${selectedCount} file${selectedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
