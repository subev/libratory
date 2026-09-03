import { createContext, useContext, type ReactNode } from "react";
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
  children,
}: {
  header: ReactNode;
  bar: ReactNode;
  filters: ReactNode;
  children: ReactNode;
}) {
  const [layout, measure] = useLayoutState(libraryLayout);

  return (
    <LayoutContext.Provider value={layout}>
      <div ref={measure} className="h-screen flex flex-col overflow-hidden bg-(--bg-page)">
        <div className="shrink-0">{header}</div>
        <div className="shrink-0">{bar}</div>
        <div className="shrink-0">{filters}</div>
        {/* The list owns its own scrolling and its own tray, the way each tab does on the book
            page: the tray has to sit outside the scroller it acts on. */}
        <div className="flex-1 min-h-0 flex flex-col" data-testid="library-pane">
          {children}
        </div>
      </div>
    </LayoutContext.Provider>
  );
}
