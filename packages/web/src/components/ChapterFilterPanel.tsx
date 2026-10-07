import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Button } from "./Button.tsx";
import { PillToggle } from "./PillToggle.tsx";
import { useVoiceLabel } from "./VoicePicker.tsx";
import { providerOfVoice, voiceSupportsSpeedControl } from "../lib/voices.ts";
import {
  NO_FILTERS,
  STALE_VOICE,
  STATUS_ORDER,
  activeFilterCount,
  isStaleNarration,
  matchesFilters,
  optionCounts,
  matchesBilingual,
  type AgeFilter,
  type BilingualFilter,
  type ChapterFilters,
  type FilterableChapter,
} from "../lib/chapter-filters.ts";

const AGE_OPTIONS: Array<{ value: Exclude<AgeFilter, "">; label: string }> = [
  { value: "day", label: "In the last 24 hours" },
  { value: "week", label: "In the last 7 days" },
  { value: "older-week", label: "More than 7 days ago" },
  { value: "older-month", label: "More than 30 days ago" },
];

const BILINGUAL_OPTIONS: Array<{ value: Exclude<BilingualFilter, "">; label: string }> = [
  { value: "needs-translation", label: "Needs a translation first" },
  { value: "needs-pairing", label: "Needs sentence pairing" },
  { value: "readable", label: "Ready to read side by side" },
  { value: "needs-words", label: "Paired, words not all linked" },
  { value: "linked", label: "Words linked" },
];

const FIELD = "px-1.5 py-1 text-xs border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)";

// Mounted only while the popover is open, so its counts cost nothing on every keystroke and poll
export function ChapterFilterPanel({
  chapters,
  filters,
  setFilters,
  current,
  now,
  files,
  bilingualLanguage,
  twoColumns,
  matchCount,
  onClose,
}: {
  chapters: FilterableChapter[];
  filters: ChapterFilters;
  setFilters: Dispatch<SetStateAction<ChapterFilters>>;
  /** The voice and speed the next synthesis will use. */
  current: { voice: string; speed: number };
  now: number;
  files?: Array<{ index: number; filename: string }>;
  /** The translation pairing is judged against; no filter without one. */
  bilingualLanguage: string | null;
  twoColumns: boolean;
  matchCount: number;
  onClose: () => void;
}) {
  const currentVoiceLabel = useVoiceLabel(current.voice);
  const setFilter = <K extends keyof ChapterFilters>(key: K, value: ChapterFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const toggleStatus = (status: string) =>
    setFilters((f) => ({
      ...f,
      statuses: f.statuses.includes(status) ? f.statuses.filter((s) => s !== status) : [...f.statuses, status],
    }));

  const statusOptions = optionCounts(chapters.map((c) => c.status), filters.statuses, STATUS_ORDER);
  const voiceOptions = optionCounts(
    chapters.flatMap((c) => (c.audioPath && c.synthesizedWith?.voice ? [c.synthesizedWith.voice] : [])),
    filters.voice && filters.voice !== STALE_VOICE ? [filters.voice] : [],
  );
  const staleCount = chapters.filter((c) => isStaleNarration(c, current)).length;
  const ageCounts = AGE_OPTIONS.map(
    (o) => chapters.filter((c) => matchesFilters(c, { ...NO_FILTERS, age: o.value }, { current, now })).length,
  );

  return (
    <div className="p-2">
      <div className={`grid gap-x-6 gap-y-3 ${twoColumns ? "grid-cols-2" : "grid-cols-1"}`}>
        <FilterField label="Status" wide={twoColumns}>
          {/* Any of the ticked ones — "is not done" is every other chip */}
          <div className="flex flex-wrap gap-1.5">
            {statusOptions.map(({ value, count }) => (
              <PillToggle key={value} selected={filters.statuses.includes(value)} onClick={() => toggleStatus(value)}>
                {value} {count}
              </PillToggle>
            ))}
          </div>
        </FilterField>
        <FilterField label="Voice" wide={twoColumns}>
          <select
            value={filters.voice}
            onChange={(e) => setFilter("voice", e.target.value)}
            aria-label="Voice the audio was made with"
            className={`${FIELD} flex-1 min-w-0`}
          >
            <option value="">Any voice</option>
            <option value={STALE_VOICE} disabled={staleCount === 0}>
              Not {currentVoiceLabel}{voiceSupportsSpeedControl(current.voice) ? ` at ${current.speed}x` : ""} — {staleCount}
            </option>
            {voiceOptions.map(({ value, count }) => (
              <VoiceOption key={value} voice={value} count={count} />
            ))}
          </select>
        </FilterField>
        <FilterField label="Made">
          <select
            value={filters.age}
            onChange={(e) => setFilter("age", e.target.value as AgeFilter)}
            aria-label="When the audio was made"
            className={`${FIELD} flex-1 min-w-0`}
          >
            <option value="">Any time</option>
            {AGE_OPTIONS.map((o, i) => (
              <option key={o.value} value={o.value}>{o.label} — {ageCounts[i]}</option>
            ))}
          </select>
        </FilterField>
        {bilingualLanguage && (
          <FilterField label="Bilingual">
            <select
              value={filters.bilingual}
              onChange={(e) => setFilter("bilingual", e.target.value as BilingualFilter)}
              aria-label={`Two-language reading with ${bilingualLanguage}`}
              className={`${FIELD} flex-1 min-w-0`}
            >
              <option value="">Any</option>
              {BILINGUAL_OPTIONS.map((o) => {
                const count = chapters.filter((c) => c.bilingual && matchesBilingual(c.bilingual, o.value)).length;
                return <option key={o.value} value={o.value}>{o.label} — {count}</option>;
              })}
            </select>
          </FilterField>
        )}
        {files && files.length > 1 && (
          <FilterField label="Source">
            <select
              value={filters.sourceFile}
              onChange={(e) => setFilter("sourceFile", e.target.value)}
              aria-label="Source file"
              className={`${FIELD} flex-1 min-w-0`}
            >
              <option value="">All files</option>
              {files.map((f) => (
                <option key={f.index} value={String(f.index)}>
                  {f.index + 1}. {f.filename}
                </option>
              ))}
            </select>
          </FilterField>
        )}
        <FilterField label="Words">
          <RangeInputs
            name="Words"
            min={filters.wordsMin}
            max={filters.wordsMax}
            onMin={(v) => setFilter("wordsMin", v)}
            onMax={(v) => setFilter("wordsMax", v)}
          />
        </FilterField>
        <FilterField label="Length">
          <RangeInputs
            name="Length in minutes"
            min={filters.minutesMin}
            max={filters.minutesMax}
            onMin={(v) => setFilter("minutesMin", v)}
            onMax={(v) => setFilter("minutesMax", v)}
          />
          <span className="text-xs text-(--text-faint) shrink-0">min</span>
        </FilterField>
      </div>
      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-(--border)">
        <span className="text-xs text-(--text-faint)">
          {matchCount} of {chapters.length} chapters match
        </span>
        <div className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setFilters(NO_FILTERS)}
          disabled={activeFilterCount(filters) === 0}
          data-testid="chapter-filters-clear"
        >
          Clear
        </Button>
        <Button variant="primary" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

function FilterField({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`flex items-center gap-3 ${wide ? "col-span-2" : ""}`}>
      <span className="text-[10px] font-bold uppercase tracking-wider text-(--text-muted) w-16 shrink-0">{label}</span>
      <div className="flex items-center gap-2 flex-1 min-w-0">{children}</div>
    </div>
  );
}

// Text fields, not type="number": the spinners took the width and left "max" reading as "r"
function RangeInputs({ name, min, max, onMin, onMax }: {
  name: string;
  min: string;
  max: string;
  onMin: (value: string) => void;
  onMax: (value: string) => void;
}) {
  const input = `${FIELD} w-full min-w-0 tabular-nums`;
  return (
    <>
      <input inputMode="decimal" value={min} onChange={(e) => onMin(e.target.value)} placeholder="from" aria-label={`${name}, from`} className={input} />
      <span className="text-(--text-faint) text-xs">–</span>
      <input inputMode="decimal" value={max} onChange={(e) => onMax(e.target.value)} placeholder="to" aria-label={`${name}, to`} className={input} />
    </>
  );
}

function VoiceOption({ voice, count }: { voice: string; count: number }) {
  const label = useVoiceLabel(voice);
  return <option value={voice}>{label} · {providerOfVoice({ id: voice })} — {count}</option>;
}
