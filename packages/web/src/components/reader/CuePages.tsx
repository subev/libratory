import { useMemo, useState } from "react";

import { PdfCanvas } from "./PdfCanvas.tsx";
import { CueOverlay } from "./CueOverlay.tsx";
import {
  chapterPages,
  cueAtPoint,
  cueIndexAt,
  cuesOfChunk,
  wholePage,
  wordIndexAt,
  type ReaderChapter,
  type ReaderCues,
  type ReaderManifest,
  type ReaderPage,
  type Rect,
} from "../../lib/reader-doc.ts";

type Spread = { key: string; page: ReaderPage; crop: Rect };

// The book's own pages with the spoken sentence drawn on them. Both the full reader and the
// chapter modal render this — a read-along that is not on the page is only a transcript.
export function CuePages({
  manifest,
  chapter,
  cues,
  ms,
  columns,
  onSeek,
  hoverChunk = null,
  onHoverCue,
  debug = { rects: false, layout: false },
  empty = "This chapter has no pages to show.",
  resolve = (url) => url,
}: {
  manifest: ReaderManifest;
  chapter: ReaderChapter;
  cues: ReaderCues | null;
  ms: number;
  // One entry per detected column rather than the whole page
  columns: boolean;
  onSeek: (ms: number) => void;
  // The chunk lit from elsewhere — a chunk button being hovered — and the reverse report
  hoverChunk?: number | null;
  onHoverCue?: (index: number | null) => void;
  debug?: { rects: boolean; layout: boolean };
  empty?: string;
  // A container's PDF is a blob URL, a server's is a route; the pages are drawn the same either way
  resolve?: (url: string) => string | undefined;
}) {
  const [hoverCue, setHoverCue] = useState(-1);
  const { pageStart, pageEnd } = chapter;
  const pages = useMemo(() => chapterPages(manifest, { pageStart, pageEnd }), [manifest, pageStart, pageEnd]);

  const spreads = useMemo<Spread[]>(() => {
    if (!columns) return pages.map((page) => ({ key: `${page.i}`, page, crop: wholePage(page) }));
    return pages.flatMap((page) => page.columns.map((column, i) => ({ key: `${page.i}-${i}`, page, crop: column })));
  }, [pages, columns]);

  if (spreads.length === 0) {
    return <p className="text-sm text-(--text-muted)" data-testid="reader-no-pages">{empty}</p>;
  }

  const activeIndex = cues ? cueIndexAt(cues.cues, ms) : -1;
  const activeCue = activeIndex >= 0 ? cues!.cues[activeIndex] : null;
  const activeWord = activeCue ? wordIndexAt(activeCue, ms) : -1;

  const linked = cuesOfChunk(cues?.cues ?? [], hoverChunk).flatMap((cue) => cue.r ?? []);
  const ring = hoverCue >= 0 ? cues?.cues[hoverCue]?.r ?? [] : [];

  const hover = (page: number, point: [number, number] | null) => {
    const at = point && cues ? cueAtPoint(cues.cues, page, point[0], point[1]) : -1;
    setHoverCue(at);
    onHoverCue?.(at >= 0 ? at : null);
  };

  return (
    <>
      {spreads.map((spread) => (
        <div key={spread.key} data-page-index={spread.page.i}>
          <PdfCanvas
            url={resolve(manifest.sources[spread.page.src]?.url ?? "") ?? ""}
            pageNumber={spread.page.p}
            crop={spread.crop}
            pageSize={{ w: spread.page.w, h: spread.page.h }}
            pointer={hoverCue >= 0}
            onHover={cues ? (point) => hover(spread.page.i, point) : undefined}
            onPointer={(x, y) => {
              if (!cues) return;
              const at = cueAtPoint(cues.cues, spread.page.i, x, y);
              if (at >= 0) onSeek(cues.cues[at].t[0]);
            }}
          >
            <CueOverlay
              page={spread.page}
              crop={spread.crop}
              cue={activeCue}
              word={activeWord >= 0 ? activeCue?.wr?.[activeWord] ?? null : null}
              cues={cues?.cues ?? []}
              linked={linked}
              ring={ring}
              debug={debug}
            />
          </PdfCanvas>
          <p className="mt-1 text-center text-[11px] text-(--text-faint)">{spread.page.i + 1}</p>
        </div>
      ))}
    </>
  );
}
