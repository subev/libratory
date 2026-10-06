import { useState } from "react";

import type { SpeedRange } from "../lib/voices.ts";

type SpeedSliderProps = {
  value: number;
  /** Called once a change is finished — on release, Enter or blur — never per pixel of a drag. */
  onChange: (speed: number) => void;
  /** What the voice's engine accepts; the stored speed is clamped to it when the voice reads. */
  range: SpeedRange;
  /** Names the engine when its range is narrower than a book's, e.g. "ElevenLabs". */
  rangeOwner?: string | null;
  disabled?: boolean;
};

const STEP = 0.05;

const roundToStep = (speed: number) => Math.round(speed / STEP) * STEP;

// A Bulgarian locale shows and types "1,1"; parseFloat would read that as 1
const parseSpeed = (text: string) => parseFloat(text.replace(",", "."));

// The stored speed lives on the book, so every change is a save and a refetch. Saving per input
// event made the thumb trail the pointer by a round trip; a drag is held here and saved once.
export function SpeedSlider({ value, onChange, range, rangeOwner = null, disabled = false }: SpeedSliderProps) {
  // `base` is the stored value the draft was made against: once the save lands the prop moves off
  // it and the draft is dropped, with no effect needed to notice.
  const [draft, setDraft] = useState<{ speed: number; base: number } | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const clamped = Math.min(range.max, Math.max(range.min, value));
  const shown = draft && draft.base === value ? draft.speed : clamped;

  const commit = (speed: number) => {
    const next = Math.min(range.max, Math.max(range.min, roundToStep(speed)));
    setTyped(null);
    if (Math.abs(next - value) < STEP / 2) {
      setDraft(null);
      return;
    }
    setDraft({ speed: next, base: value });
    onChange(Number(next.toFixed(2)));
  };

  const finishDrag = () => {
    if (draft && draft.base === value) commit(draft.speed);
  };

  if (disabled) {
    return (
      <div className="w-56">
        <span className="block text-sm font-medium text-(--text-secondary) mb-1">Speed: fixed for this voice</span>
        <input type="range" disabled value={1} min={0.5} max={2} aria-label="Speed" className="w-full accent-(--accent) opacity-50 cursor-not-allowed" />
      </div>
    );
  }

  return (
    <div className="w-56">
      <div className="flex items-center justify-between gap-2 mb-1">
        <label htmlFor="speed-input" className="text-sm font-medium text-(--text-secondary)">
          Speed
        </label>
        <span className="flex items-center gap-1 text-sm text-(--text-secondary)">
          <input
            id="speed-input"
            type="text"
            inputMode="decimal"
            value={typed ?? shown.toFixed(2)}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => {
              if (typed === null) return;
              const speed = parseSpeed(typed);
              if (Number.isFinite(speed)) commit(speed);
              else setTyped(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setTyped(null);
            }}
            className="w-16 rounded border border-(--border-input) bg-(--bg-input) px-1.5 py-0.5 text-right tabular-nums"
            data-testid="speed-input"
          />
          x
        </span>
      </div>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={STEP}
        value={shown}
        aria-label="Speed"
        onChange={(e) => setDraft({ speed: parseFloat(e.target.value), base: value })}
        onPointerUp={finishDrag}
        onKeyUp={finishDrag}
        onBlur={finishDrag}
        className="w-full accent-(--accent)"
        data-testid="speed-slider"
      />
      {rangeOwner && (
        <p className="mt-0.5 text-xs text-(--text-faint)">
          {rangeOwner} reads {range.min}–{range.max}x
          {value !== clamped && ` — the saved ${value}x is read as ${clamped}x`}
        </p>
      )}
    </div>
  );
}
