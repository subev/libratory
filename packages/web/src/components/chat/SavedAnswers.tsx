import { useState } from "react";
import { trpc } from "../../trpc.ts";
import { MarkdownBlock } from "../MarkdownBlock.tsx";

export function SavedAnswers() {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const { data: notes = [] } = trpc.notes.listLibrary.useQuery();
  const deleteNote = trpc.notes.delete.useMutation({
    onSuccess: () => utils.notes.listLibrary.invalidate(),
  });

  if (notes.length === 0) return null;

  return (
    <div className="border-t border-(--border) pt-3 mt-2" data-testid="saved-answers">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm text-(--text-muted) hover:text-(--text-primary)"
      >
        <svg className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z" />
        </svg>
        Saved answers ({notes.length})
      </button>
      {open && (
        <div className="divide-y divide-(--divide) mt-2">
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
                    ✕
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
      )}
    </div>
  );
}
