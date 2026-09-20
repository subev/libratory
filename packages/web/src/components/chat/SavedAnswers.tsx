import { useState } from "react";
import { trpc } from "../../trpc.ts";
import { MarkdownBlock } from "../MarkdownBlock.tsx";
import { Modal, ModalHeader } from "../Modal.tsx";
import { IconClose } from "../icons.tsx";

// Answers kept with Save as note. They are notes, not conversations: deleting a chat leaves them here.
export function SavedAnswersModal({ onClose }: { onClose: () => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const { data: notes = [] } = trpc.notes.listLibrary.useQuery();
  const deleteNote = trpc.notes.delete.useMutation({
    onSuccess: () => utils.notes.listLibrary.invalidate(),
  });

  return (
    <Modal size="md" onClose={onClose} testId="saved-answers">
      <ModalHeader title="Saved answers" subtitle="Kept with Save as note — separate from the conversations they came from" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {notes.length === 0 && <p className="py-6 text-center text-sm text-(--text-muted)">Nothing saved yet.</p>}
        <div className="divide-y divide-(--divide)">
          {notes.map((note) => {
            const expanded = expandedId === note.id;
            return (
              <div key={note.id} className="py-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setExpandedId(expanded ? null : note.id)}
                    className="text-sm text-(--text-primary) text-left truncate flex-1 hover:text-(--text-secondary)"
                  >
                    {note.prompt}
                  </button>
                  <span className="text-xs text-(--text-faint) shrink-0">
                    {new Date(note.createdAt).toLocaleDateString()}
                  </span>
                  <button
                    onClick={() => deleteNote.mutate({ id: note.id })}
                    className="text-xs text-(--text-faint) hover:text-(--danger-text) shrink-0"
                    title="Delete saved answer"
                  >
                    <IconClose className="h-3 w-3" />
                  </button>
                </div>
                {expanded && (
                  <div className="mt-2 pl-1">
                    <MarkdownBlock>{note.result}</MarkdownBlock>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
