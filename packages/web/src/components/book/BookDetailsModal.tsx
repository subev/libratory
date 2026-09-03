import { useState } from "react";
import { Modal, ModalHeader } from "../Modal.tsx";
import { Button } from "../Button.tsx";
import { BOOK_LANGUAGE_OPTIONS } from "../../lib/languages.ts";

// Author and language were inline-editable in a subline the shell's head meta replaces, and that
// line hides below 1180 — which would have left the author with no home at all. The title keeps its
// click-to-rename in the header. The extraction properties stay in ExtractModal: they describe the
// source and outlive any single run.
export function BookDetailsModal({
  author,
  language,
  onSave,
  onClose,
}: {
  author: string | null;
  language: string | null;
  onSave: (next: { author: string | null; language: string | null }) => void;
  onClose: () => void;
}) {
  const [draftAuthor, setDraftAuthor] = useState(author ?? "");
  const [draftLanguage, setDraftLanguage] = useState(language ?? "");

  const field = "w-full rounded border border-(--border-input) bg-(--bg-input) px-2 py-1.5 text-sm text-(--text-primary)";

  function save() {
    onSave({ author: draftAuthor.trim() || null, language: draftLanguage || null });
    onClose();
  }

  return (
    <Modal size="sm" onClose={onClose} testId="book-details-modal">
      <ModalHeader title="Book details" onClose={onClose} />
      <div className="p-4 space-y-3">
        <label className="block">
          <span className="block mb-1 text-xs font-medium text-(--text-secondary)">Author</span>
          <input
            value={draftAuthor}
            onChange={(e) => setDraftAuthor(e.target.value)}
            placeholder="Add an author"
            title="Who wrote it — travels with the book when it is exported"
            className={field}
            data-testid="book-details-author"
          />
        </label>
        <label className="block">
          <span className="block mb-1 text-xs font-medium text-(--text-secondary)">Language</span>
          <select value={draftLanguage} onChange={(e) => setDraftLanguage(e.target.value)} className={field} data-testid="book-details-language">
            <option value="">Not set</option>
            {BOOK_LANGUAGE_OPTIONS.map(({ code, label }) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
          <span className="block mt-1 text-xs text-(--text-muted)">Decides which voices the picker offers first.</span>
        </label>
      </div>
      <div className="flex items-center gap-2 px-4 py-3 border-t border-(--border)">
        <div className="flex-1" />
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} data-testid="book-details-save">Save</Button>
      </div>
    </Modal>
  );
}
