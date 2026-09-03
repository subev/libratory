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
  active,
  scroll = true,
  children,
}: {
  active: boolean;
  /** Off for a tab that pins part of itself and scrolls the rest. */
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    // The class does the hiding, not the attribute: a display utility beats [hidden]'s UA
    // display:none, so "flex flex-col" on an inactive panel would leave it on screen.
    <div
      hidden={!active}
      className={
        !active ? "hidden" : `flex-1 min-h-0 ${scroll ? "overflow-y-auto overscroll-contain" : "flex flex-col"}`
      }
    >
      {children}
    </div>
  );
}
