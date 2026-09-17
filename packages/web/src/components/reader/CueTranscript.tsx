import { StructuredText } from "./StructuredText.tsx";
import { transcriptSegments, transcriptWordRange } from "../../lib/transcript-segments.ts";
import type { ReaderText } from "../../lib/reader-doc.ts";
import { useMemo, useState } from "react";

import { cueIndexAt, wordIndexAt, type ReaderCue, type ReaderCues } from "../../lib/reader-doc.ts";

const READING_PANE = "mx-auto w-full max-w-prose rounded-lg bg-(--bg-reading) p-7 font-reading text-lg leading-relaxed text-(--text-primary)";

// The cue list is the chapter's spoken text in order, so reading along with it needs no
// second document — and it works for chapters that never map onto a page at all.
export function CueTranscript({
  cues,
  ms,
  onSeek,
  hoverChunk = null,
  onHoverCue,
  className = READING_PANE,
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
  const segmentsByStart = useMemo(() => new Map(cues?.text?.blocks?.map((block) => [block.start, transcriptSegments(block.start, block.end, cues.cues)])), [cues]);
  if (!cues) return <p className="text-sm text-(--text-muted)">{empty}</p>;

  const activeIndex = cueIndexAt(cues.cues, ms);
  const activeCue = activeIndex >= 0 ? cues.cues[activeIndex] : undefined;
  const activeWord = activeCue ? wordIndexAt(activeCue, ms) : -1;

  const document = cues.text;
  if (document?.blocks) {
    const wordRange = transcriptWordRange(document.text, activeCue, activeWord);
    return <article className={className} data-testid="reader-text-view">
      <StructuredText document={document} render={(start) => (segmentsByStart.get(start) ?? []).map((segment) => {
        const cue = segment.cue === null ? undefined : cues.cues[segment.cue];
        const from = Math.max(segment.start, wordRange?.start ?? segment.end);
        const to = Math.min(segment.end, wordRange?.end ?? segment.start);
        const content = from < to ? <>{document.text.slice(segment.start, from)}<mark className="bg-(--accent)/60" data-testid="reader-word">{document.text.slice(from, to)}</mark>{document.text.slice(to, segment.end)}</> : document.text.slice(segment.start, segment.end);
        return cue ? <span key={segment.start}
          onClick={() => onSeek(cue.t[0])}
          onMouseEnter={() => { setHoverCue(segment.cue ?? -1); onHoverCue?.(segment.cue); }}
          onMouseLeave={() => { setHoverCue(-1); onHoverCue?.(null); }}
          className={`cursor-pointer ${segment.cue === activeIndex ? "bg-(--accent)/35" : segment.cue === hoverCue ? "bg-(--accent)/22" : cue.c === hoverChunk ? "bg-(--accent-subtle)" : "hover:bg-(--bg-subtle)"}`}
          data-testid={segment.cue === activeIndex ? "text-cue-active" : "text-cue"}>{content}</span> : <span key={segment.start}>{content}</span>;
      })} />
    </article>;
  }

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

// The same reading pane for a chapter with no narration: same styles, nothing to mark
export function TextBody({ text, document, className = READING_PANE }: { text: string; document?: ReaderText; className?: string }) {
  if (document?.blocks) return <article className={className} data-testid="reader-text-view"><StructuredText document={document} /></article>;
  return (
    <article className={className} data-testid="reader-text-view">
      {text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block, i) => (
        <p key={i} className="mb-4 last:mb-0 whitespace-pre-wrap">{block}</p>
      ))}
    </article>
  );
}
