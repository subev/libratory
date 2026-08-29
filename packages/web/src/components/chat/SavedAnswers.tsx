import { useState } from "react";
import { trpc } from "../../trpc.ts";
import { MarkdownBlock } from "../MarkdownBlock.tsx";
import { IconChevronRight, IconClose } from "../icons.tsx";

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
        <IconChevronRight className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
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
      )}
    </div>
  );
}
