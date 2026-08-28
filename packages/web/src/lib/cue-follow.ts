import { useEffect, useRef } from "react";

import { cueIndexAt, wordIndexAt, type ReaderCues } from "./reader-doc.ts";

// Keeping the spoken cue in view, in whatever is scrolling — the reader scrolls the window,
// the chapter modal scrolls its own panel.
export type FollowBand = { top: number; bottom: number; landing: number };

// Auto-scroll steps back this long after the reader touches the page themselves
const PAUSE_MS = 5000;

let lastGesture = 0;
let listening = false;

function watchGestures() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const note = () => { lastGesture = Date.now(); };
  window.addEventListener("wheel", note, { passive: true, capture: true });
  window.addEventListener("touchmove", note, { passive: true, capture: true });
}

function scrollParent(element: Element): HTMLElement | null {
  let node = element.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

export type Span = { top: number; bottom: number };

// How far to scroll to land the cue, or null when it is already inside the safe area. A cue
// taller than that area hands the guarantee to the word being spoken, since keeping the top of a
// long sentence in view is what strands the cursor below the fold.
export function followDelta(
  cue: Span,
  word: Span | null,
  viewHeight: number,
  band: FollowBand,
  jump: boolean,
): number | null {
  const safeTop = band.top;
  const safeBottom = viewHeight - band.bottom;
  const tall = cue.bottom - cue.top > safeBottom - safeTop;
  // Between two words there is no word, and that says nothing new about where the reader is.
  // Re-aiming at the top of a long sentence during one of those gaps is what makes the page
  // jitter — the last word placed is still the best guess, so stay where it left us. A jump has
  // nothing on screen yet, so there the sentence's own top is the only thing to aim at.
  const focus = tall ? word ?? (jump ? { top: cue.top, bottom: cue.top } : null) : cue;
  if (!focus) return null;

  if (!jump && focus.top >= safeTop && focus.bottom <= safeBottom) return null;

  // Land it high enough that the next several cues fit below — following along should scroll in
  // stretches, not on every sentence — without pushing its own tail past the bottom edge
  const height = focus.bottom - focus.top;
  const landing = Math.max(safeTop, Math.min(viewHeight * band.landing, safeBottom - height));
  return focus.top - landing;
}

function span(elements: Element[], viewTop: number): Span | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const element of elements) {
    const box = element.getBoundingClientRect();
    if (box.height === 0) continue;
    top = Math.min(top, box.top - viewTop);
    bottom = Math.max(bottom, box.bottom - viewTop);
  }
  return top === Infinity ? null : { top, bottom };
}

// jump: land the cue now and without animation — a new chapter or view has nothing on screen
// whose movement would mean anything, and sliding there from the last one only jiggles.
// Returns whether there was a cue to place at all.
export function followCue(band: FollowBand, { jump = false } = {}): boolean {
  watchGestures();
  if (!jump && Date.now() - lastGesture < PAUSE_MS) return false;

  const all = (selector: string) => [...document.querySelectorAll(selector)];
  const marks = all('[data-testid="cue-rect"], [data-testid="text-cue-active"]');
  const firstMark = marks[0];
  if (!firstMark) return false;

  const scroller = scrollParent(firstMark);
  const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
  const viewHeight = scroller ? scroller.clientHeight : window.innerHeight;

  const cue = span(marks, viewTop);
  if (!cue) return false;
  const word = span(all('[data-testid="cue-word-rect"], [data-testid="reader-word"]'), viewTop);

  const delta = followDelta(cue, word, viewHeight, band, jump);
  if (delta === null) return true;

  const behavior = jump || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  if (scroller) scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
  else window.scrollTo({ top: window.scrollY + delta, behavior });
  return true;
}

// Both surfaces follow the same way: on the cue, on the word inside an over-tall one, and with a
// jump the first time a cue is placed under a new chapter or view.
export function useFollowCue(cues: ReaderCues | null, ms: number, band: FollowBand, anchor: string): void {
  const cue = cues ? cueIndexAt(cues.cues, ms) : -1;
  const active = cue >= 0 ? cues?.cues[cue] : undefined;
  const word = active ? wordIndexAt(active, ms) : -1;
  const settled = useRef("");

  useEffect(() => {
    if (followCue(band, { jump: settled.current !== anchor })) settled.current = anchor;
  }, [cue, word, anchor, band]);
}
