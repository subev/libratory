import { createContext, useContext, useState, type ReactNode } from "react";
import { captureDrop, hasFiles, type DroppedItems } from "../../lib/dnd.ts";
import { libraryLayout, type LibraryLayout } from "../../lib/library-layout.ts";
import { useLayoutState } from "../../lib/use-layout-state.ts";

// The page is the window, as on the book page: the header, the bars and the tray are pinned and the
// list is the only scroller. It replaces a centred column that scrolled everything together, with
// an upload zone taking the first third of it before a single book was visible.
const LayoutContext = createContext<LibraryLayout>(libraryLayout(1280));

export function useLibraryLayout(): LibraryLayout {
  return useContext(LayoutContext);
}

export function LibraryShell({
  header,
  bar,
  filters,
  onFilesDropped,
  children,
}: {
  header: ReactNode;
  bar: ReactNode;
  filters: ReactNode;
  /** Dropping PDFs on the library is how the page used to work; the zone moved, the drop did not. */
  onFilesDropped: (drop: DroppedItems) => void;
  children: ReactNode;
}) {
  const [layout, measure] = useLayoutState(libraryLayout);
  const [dropping, setDropping] = useState(false);

  return (
    <LayoutContext.Provider value={layout}>
      <div ref={measure} className="h-screen flex flex-col overflow-hidden bg-(--bg-page)">
        <div className="shrink-0">{header}</div>
        <div className="shrink-0">{bar}</div>
        <div className="shrink-0">{filters}</div>
        {/* The list owns its own scrolling and its own tray, the way each tab does on the book
            page: the tray has to sit outside the scroller it acts on. */}
        <div
          className={`relative flex-1 min-h-0 flex flex-col ${dropping ? "outline-2 outline-dashed -outline-offset-2 outline-(--accent)" : ""}`}
          // A row being dragged onto a folder carries our own MIME and must fall through
          onDragOver={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDropping(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
          onDrop={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setDropping(false);
            onFilesDropped(captureDrop(e));
          }}
          data-testid="library-pane"
        >
          {children}
        </div>
      </div>
    </LayoutContext.Provider>
  );
}
