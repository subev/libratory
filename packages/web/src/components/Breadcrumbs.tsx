import { useState } from "react";
import { Link } from "react-router";
import { getDragItems, hasDragItems, type DragItems } from "../lib/dnd.ts";

export type BreadcrumbItem = {
  to?: string;
  label: string;
  // When set (null = root), the crumb accepts dragged rows and moves them there
  dropFolderId?: string | null;
};

export function Breadcrumbs({
  items,
  onDropItems,
}: {
  items: BreadcrumbItem[];
  onDropItems?: (targetFolderId: string | null, items: DragItems) => void;
}) {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  return (
    <nav className="flex items-center gap-1.5 text-sm text-(--text-muted)" data-testid="breadcrumbs">
      {items.map((item, i) => {
        const droppable = onDropItems !== undefined && item.dropFolderId !== undefined;
        const dropProps = droppable
          ? {
              onDragOver: (e: React.DragEvent) => {
                if (!hasDragItems(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverIndex(i);
              },
              onDragLeave: () => setDragOverIndex(null),
              onDrop: (e: React.DragEvent) => {
                setDragOverIndex(null);
                const dragged = getDragItems(e);
                if (!dragged) return;
                e.preventDefault();
                onDropItems(item.dropFolderId ?? null, dragged);
              },
            }
          : {};
        const highlight = dragOverIndex === i ? "outline outline-2 outline-(--accent) rounded" : "";
        return (
          <span key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <span className="text-(--text-faint)">›</span>}
            {item.to ? (
              <Link to={item.to} className={`text-(--accent) hover:text-(--accent-hover) truncate px-0.5 ${highlight}`} {...dropProps}>
                {item.label}
              </Link>
            ) : (
              <span className={`text-(--text-secondary) font-medium truncate px-0.5 ${highlight}`} {...dropProps}>
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
