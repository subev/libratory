// The chapter table's filter panel, kept pure: what a bound means, and which rows a choice keeps.

import type { SynthesizedWith } from "../../../server/src/schema.ts";
import { isReadable, needsPairing, needsTranslation, type BilingualChapterState } from "./bilingual-state.ts";

export type AgeFilter = "" | "day" | "week" | "older-week" | "older-month";
/** Where a chapter stands on the way to two-language reading, in the steps a person acts on. */
export type BilingualFilter = "" | "needs-translation" | "needs-pairing" | "readable" | "needs-words" | "linked";
export const STALE_VOICE = "stale";

export type ChapterFilters = {
  /** Any of these; empty means every status. */
  statuses: string[];
  /** "" any, STALE_VOICE for audio that is not the current voice and speed, else one voice id. */
  voice: string;
  age: AgeFilter;
  wordsMin: string;
  wordsMax: string;
  /** Minutes, decimals allowed: chapters run minutes long, and seconds were never the unit. */
  minutesMin: string;
  minutesMax: string;
  /** "" every file, else a source file's index — offered only when the book has several. */
  sourceFile: string;
  bilingual: BilingualFilter;
};

export const NO_FILTERS: ChapterFilters = {
  statuses: [],
  voice: "",
  age: "",
  wordsMin: "",
  wordsMax: "",
  minutesMin: "",
  minutesMax: "",
  sourceFile: "",
  bilingual: "",
};

export type FilterableChapter = {
  status: string;
  wordCount: number;
  durationMs: number | null;
  sourceFileIndex: number | null;
  audioPath: string | null;
  synthesizedWith: SynthesizedWith | null;
  /** Absent when the book has no translation to pair with. */
  bilingual?: BilingualChapterState | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Empty is no bound and 0 is a real one — `max 0 words` used to be read as "no limit" while the
// badge counted it, so the panel said filtered and the table said 62 of 62.
export function parseBound(value: string): number | null {
  const trimmed = value.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function activeFilterCount(f: ChapterFilters): number {
  return [
    f.statuses.length > 0,
    f.sourceFile !== "",
    f.voice !== "",
    f.age !== "",
    f.bilingual !== "",
    parseBound(f.wordsMin) !== null || parseBound(f.wordsMax) !== null,
    parseBound(f.minutesMin) !== null || parseBound(f.minutesMax) !== null,
  ].filter(Boolean).length;
}

// Audio with no recorded voice predates the snapshot; it cannot be shown to match, so it counts.
export function isStaleNarration(
  ch: FilterableChapter,
  current: { voice: string; speed: number },
): boolean {
  if (!ch.audioPath) return false;
  const made = ch.synthesizedWith;
  if (!made?.voice || made.voice !== current.voice) return true;
  return made.speed != null && made.speed !== current.speed;
}

function matchesAge(at: string | undefined, age: AgeFilter, now: number): boolean {
  if (age === "") return true;
  if (!at) return false;
  const elapsed = now - new Date(at).getTime();
  switch (age) {
    case "day": return elapsed < DAY_MS;
    case "week": return elapsed < 7 * DAY_MS;
    case "older-week": return elapsed >= 7 * DAY_MS;
    case "older-month": return elapsed >= 30 * DAY_MS;
    default: {
      const unhandled: never = age;
      throw new Error(`unhandled age filter ${unhandled}`);
    }
  }
}

export function matchesBilingual(state: BilingualChapterState, filter: Exclude<BilingualFilter, "">): boolean {
  switch (filter) {
    case "needs-translation": return needsTranslation(state.step);
    case "needs-pairing": return needsPairing(state.step) || state.step === "pairing";
    case "readable": return isReadable(state.step);
    case "needs-words": return state.step === "paired" || state.step === "linking";
    case "linked": return state.step === "linked";
    default: {
      const unhandled: never = filter;
      throw new Error(`unhandled bilingual filter ${unhandled}`);
    }
  }
}

function inRange(value: number, min: number | null, max: number | null): boolean {
  return (min === null || value >= min) && (max === null || value <= max);
}

export function matchesFilters(
  ch: FilterableChapter,
  f: ChapterFilters,
  ctx: { current: { voice: string; speed: number }; now: number },
): boolean {
  if (f.statuses.length > 0 && !f.statuses.includes(ch.status)) return false;
  if (f.sourceFile !== "" && ch.sourceFileIndex !== Number(f.sourceFile)) return false;
  if (f.voice === STALE_VOICE) {
    if (!isStaleNarration(ch, ctx.current)) return false;
  } else if (f.voice !== "" && !(ch.audioPath && ch.synthesizedWith?.voice === f.voice)) {
    return false;
  }
  if (f.bilingual !== "" && !(ch.bilingual && matchesBilingual(ch.bilingual, f.bilingual))) return false;
  // A date or a length belongs to audio; a chapter with none has neither, not a zero
  if (f.age !== "" && !(ch.audioPath && matchesAge(ch.synthesizedWith?.at, f.age, ctx.now))) return false;
  if (!inRange(ch.wordCount, parseBound(f.wordsMin), parseBound(f.wordsMax))) return false;
  const fromMinutes = parseBound(f.minutesMin);
  const toMinutes = parseBound(f.minutesMax);
  if (fromMinutes !== null || toMinutes !== null) {
    if (!ch.audioPath || ch.durationMs === null) return false;
    if (!inRange(ch.durationMs / 60_000, fromMinutes, toMinutes)) return false;
  }
  return true;
}

// The table's own statuses in the order they happen, so chips keep their places while counts move
export const STATUS_ORDER = [
  "done", "failed", "suspended", "pending", "normalizing", "synthesizing",
  "translating", "rewriting", "untranslated", "missing",
];

/**
 * Each value present in the rows with how many have it — plus every chosen value no row has any
 * more, at 0, so a filter that is doing the filtering can still be seen and undone. In `order`
 * when given (unknown values after it), else most common first.
 */
export function optionCounts(
  values: Iterable<string>,
  chosen: readonly string[],
  order?: readonly string[],
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const v of chosen) if (!counts.has(v)) counts.set(v, 0);
  const rank = (v: string) => {
    const i = order?.indexOf(v) ?? -1;
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (order ? rank(a.value) - rank(b.value) : b.count - a.count) || a.value.localeCompare(b.value));
}
