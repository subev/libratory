import { useState } from "react";

import { AfterExtractChoice } from "./AfterExtractChoice.tsx";
import { BOOK_LANGUAGE_OPTIONS } from "../lib/languages.ts";
import { Modal, ModalHeader } from "./Modal.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { Button } from "./Button.tsx";

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
  const [autoSynthesize, setAutoSynthesize] = useState(false);
  const blocked = disabledReason(scope) ?? (losing > 0 && !confirmed ? "Confirm the chapters you're replacing" : null);

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
              to look like text. Much slower; the original PDF is untouched. Pages with no text layer can't be
              lined up with the voice word by word, so read-along marks a paragraph at a time; Text view still
              marks every word.
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
          onClick={() => onStart(scope, autoSynthesize)}
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
