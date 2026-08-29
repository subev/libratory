import { useState } from "react";

import { cueIndexAt, wordIndexAt, type ReaderCue, type ReaderCues } from "../../lib/reader-doc.ts";

// The cue list is the chapter's spoken text in order, so reading along with it needs no
// second document — and it works for chapters that never map onto a page at all.
export function CueTranscript({
  cues,
  ms,
  onSeek,
  hoverChunk = null,
  onHoverCue,
  className = "mx-auto w-full max-w-prose rounded-lg bg-(--bg-reading) p-7 font-reading text-lg leading-relaxed text-(--text-primary)",
  empty = "No narration to read along with yet.",
}: {
  cues: ReaderCues | null;
  ms: number;
  onSeek: (ms: number) => void;
  // The chunk lit from elsewhere — a chunk button being hovered — and the reverse report
  hoverChunk?: number | null;
  onHoverCue?: (index: number | null) => void;
  className?: string;
  empty?: string;
}) {
  const [hoverCue, setHoverCue] = useState(-1);
  if (!cues) return <p className="text-sm text-(--text-muted)">{empty}</p>;

  const activeIndex = cueIndexAt(cues.cues, ms);
  const activeCue = activeIndex >= 0 ? cues.cues[activeIndex] : undefined;
  const activeWord = activeCue ? wordIndexAt(activeCue, ms) : -1;

  return (
    <article className={className} data-testid="reader-text-view">
      {cues.cues.map((cue, i) => (
        <span
          key={i}
          onClick={() => onSeek(cue.t[0])}
          onMouseEnter={() => { setHoverCue(i); onHoverCue?.(i); }}
          onMouseLeave={() => { setHoverCue(-1); onHoverCue?.(null); }}
          className={`cursor-pointer ${
            i === activeIndex
              ? "bg-(--accent)/35"
              : i === hoverCue
                ? "bg-(--accent)/22"
                : cue.c === hoverChunk
                  ? "bg-(--accent-subtle)"
                  : "hover:bg-(--bg-subtle)"
          }`}
          data-testid={i === activeIndex ? "text-cue-active" : "text-cue"}
        >
          {i === activeIndex ? <CueText cue={cue} word={activeWord} /> : cue.s}{" "}
        </span>
      ))}
    </article>
  );
}

// Marking a slice of the cue's own text, rather than re-joining the words, keeps the spacing
// the book has — the words carry no punctuation spacing of their own.
export function CueText({ cue, word }: { cue: ReaderCue; word: number }) {
  const spoken = word >= 0 ? cue.w?.[word]?.[2] : undefined;
  if (!spoken) return <>{cue.s}</>;

  let cursor = 0;
  for (let i = 0; i < word; i++) {
    const before = cue.w?.[i]?.[2];
    if (before === undefined) continue;
    const at = cue.s.indexOf(before, cursor);
    if (at >= 0) cursor = at + before.length;
  }
  const start = cue.s.indexOf(spoken, cursor);
  if (start < 0) return <>{cue.s}</>;

  return (
    <>
      {cue.s.slice(0, start)}
      <mark className="bg-(--accent)/60" data-testid="reader-word">{spoken}</mark>
      {cue.s.slice(start + spoken.length)}
    </>
  );
}
