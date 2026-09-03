import { createContext, useContext, type ReactNode } from "react";
import { bookLayout, type BookLayout } from "../../lib/book-layout.ts";
import { useElementWidth } from "../../lib/use-element-width.ts";

// The page is the window: header, tabs and tray are pinned and the tab body is the only scroller.
// It replaces a scrolling page whose chapter table had a height cap and a scrollbar of its own, so
// a long book nested two — and the toolbar acting on the selection scrolled away from the table.
const LayoutContext = createContext<BookLayout>(bookLayout(1280));

export function useShellLayout(): BookLayout {
  return useContext(LayoutContext);
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
  const { measure, width } = useElementWidth();

  return (
    <LayoutContext.Provider value={bookLayout(width)}>
      <div ref={measure} className="h-screen flex flex-col overflow-hidden bg-(--bg-page)">
        <div className="shrink-0">{header}</div>
        <div className="shrink-0">{tabs}</div>
        {banner ? <div className="shrink-0">{banner}</div> : null}
        {/* overscroll-contain because the body no longer scrolls: without it a modal's overscroll
            chains into whichever tab is behind it, which is what useBodyScrollLock used to catch. */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{children}</div>
        {tray ? <div className="shrink-0">{tray}</div> : null}
        {dock ? <div className="shrink-0">{dock}</div> : null}
      </div>
    </LayoutContext.Provider>
  );
}

// Inactive tabs stay mounted: ChapterTable holds nine filter states, the shift-range anchor and the
// floating player's chapter, and unmounting it clears every one of them and stops the audio.
export function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div hidden={!active} className="h-full">
      {children}
    </div>
  );
}
