import { createContext, useContext, type ReactNode } from "react";
import { bookLayout, type BookLayout } from "../../lib/book-layout.ts";
import { useLayoutState } from "../../lib/use-layout-state.ts";

// The page is the window: header, tabs and tray are pinned and the tab body is the only scroller.
// It replaces a scrolling page whose chapter table had a height cap and a scrollbar of its own, so
// a long book nested two — and the toolbar acting on the selection scrolled away from the table.
const LayoutContext = createContext<BookLayout>(bookLayout(1280));

export function useShellLayout(): BookLayout {
  return useContext(LayoutContext);
}

// For a component that takes the layout as a prop rather than reading the context — the page that
// owns the shell sits above the provider, so it cannot call the hook itself.
export function WithShellLayout({ children }: { children: (layout: BookLayout) => ReactNode }) {
  return children(useContext(LayoutContext));
}

export function BookShell({
  header,
  tabs,
  banner,
  tray,
  dock,
  children,
}: {
  header: ReactNode;
  tabs: ReactNode;
  banner?: ReactNode;
  tray?: ReactNode;
  dock?: ReactNode;
  children: ReactNode;
}) {
  const [layout, measure] = useLayoutState(bookLayout);

  return (
    <LayoutContext.Provider value={layout}>
      <div ref={measure} className="h-screen flex flex-col overflow-hidden bg-(--bg-page)">
        <div className="shrink-0">{header}</div>
        <div className="shrink-0">{tabs}</div>
        {banner ? <div className="shrink-0">{banner}</div> : null}
        {/* Each tab owns its scrolling: Chapters pins its filter bar and scrolls only the table,
            the rest scroll whole. The shell just gives them the height that is left. */}
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
        {tray ? <div className="shrink-0">{tray}</div> : null}
        {dock ? <div className="shrink-0">{dock}</div> : null}
      </div>
    </LayoutContext.Provider>
  );
}

// Inactive tabs stay mounted: ChapterTable holds nine filter states, the shift-range anchor and the
// floating player's chapter, and unmounting it clears every one of them and stops the audio.
// overscroll-contain because the body no longer scrolls — without it a modal's overscroll chains
// into whichever tab is behind it, which is what useBodyScrollLock used to catch.
export function TabPanel({
  id,
  active,
  scroll = true,
  children,
}: {
  id: string;
  active: boolean;
  /** Off for a tab that pins part of itself and scrolls the rest. */
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      id={`panel-${id}`}
      role="tabpanel"
      aria-labelledby={`stage-tab-${id}`}
      hidden={!active}
      className={`flex-1 min-h-0 ${scroll ? "overflow-y-auto overscroll-contain" : "flex flex-col"}`}
    >
      {children}
    </div>
  );
}
