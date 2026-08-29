import { cropStyle, type CueRect, type ReaderCue, type ReaderPage, type Rect } from "../../lib/reader-doc.ts";

// The page under these is white paper in either theme, so they always multiply — screening
// against white erases the band and leaves only the glyphs tinted
export function CueOverlay({
  page,
  crop,
  cue,
  word,
  cues,
  linked,
  ring,
  debug,
}: {
  page: ReaderPage;
  crop: Rect;
  cue: ReaderCue | null;
  word: CueRect[] | null;
  cues: ReaderCue[];
  // One hue throughout, varying only in strength: the chunk the pointer rests on is tinted, and
  // the one cue a click would seek to is ringed inside it
  linked: CueRect[];
  ring: CueRect[];
  debug: { rects: boolean; layout: boolean };
}) {
  const style = (x: number, y: number, width: number, height: number) => cropStyle(page, crop, x, y, width, height);
  const pointsToRect = (box: Rect) => style(
    (box[0] / page.w) * 10_000,
    (box[1] / page.h) * 10_000,
    (box[2] / page.w) * 10_000,
    (box[3] / page.h) * 10_000,
  );

  // Softest first: the chunk under the pointer, the sentence a click would seek to, the sentence
  // being spoken, the word inside it. The element for each persists, so moving one is a transition
  const layers = [
    { rects: linked, className: "bg-(--cue-linked) mix-blend-multiply", testId: "cue-linked-rect" },
    { rects: ring, className: "outline-2 outline-offset-1 outline-(--cue-ring)/80", testId: "cue-ring-rect" },
    { rects: cue?.r ?? [], className: "bg-(--cue-active) mix-blend-multiply", testId: "cue-rect" },
    {
      rects: word ?? [],
      className: "bg-(--cue-word) mix-blend-multiply transition-all duration-150 ease-out motion-reduce:transition-none",
      testId: "cue-word-rect",
    },
  ];

  return (
    <div className="pointer-events-none absolute inset-0" data-testid="cue-overlay">
      {debug.layout && (
        <>
          <div className="absolute border border-dashed border-sky-500/70" style={pointsToRect(page.content)} />
          {page.columns.map((column, i) => (
            <div key={i} className="absolute border border-dashed border-fuchsia-500/70" style={pointsToRect(column)} />
          ))}
        </>
      )}

      {debug.rects &&
        cues.flatMap((other, i) =>
          (other.r ?? [])
            .filter(([p]) => p === page.i)
            .map((rect, j) => (
              <div key={`${i}-${j}`} className="absolute border border-emerald-500/40" style={style(rect[1], rect[2], rect[3], rect[4])} />
            )),
        )}

      {layers.map((layer) =>
        layer.rects
          .filter(([p]) => p === page.i)
          .map((rect, i) => (
            <div
              key={`${layer.testId}-${i}`}
              className={`absolute rounded-[2px] ${layer.className}`}
              style={style(rect[1], rect[2], rect[3], rect[4])}
              data-testid={layer.testId}
            />
          )),
      )}
    </div>
  );
}
