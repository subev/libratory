import { memo } from "react";

import {
  languageLabel,
  voiceHasWordTiming,
  voiceIsForeignIn,
  voiceMissingEngine,
  type Voice,
} from "../../lib/voices.ts";
import { Button } from "../Button.tsx";
import { IconCheck, IconPause, IconPlay, IconSpinner } from "../icons.tsx";
import { trpc } from "../../trpc.ts";
import { useVoicePicker } from "./context.tsx";

// Word timing is the difference between words lighting up as they are read and sentences
// doing so, and between word-level and sentence-level two-language reading; said on every row
// because it is the one thing a listener cannot hear in the preview.
function describe(voice: Voice, foreignIn: string | null): string {
  const parts: string[] = [];
  if (foreignIn) parts.push(`Not a native ${languageLabel(foreignIn)} voice`);
  if (voice.gender) parts.push(voice.gender === "F" ? "Female" : "Male");
  parts.push(voiceHasWordTiming(voice.id, voice.language) ? "Word timing" : "Sentence timing");
  if (voice.note) parts.push(voice.note);
  return parts.join(" · ");
}

// `language` is the list the row sits in; a voice that only reads it previews in it, since its own
// language would say nothing about how it sounds here.
export const VoiceRow = memo(function VoiceRow({ voice, language, action }: { voice: Voice; language?: string; action?: React.ReactNode }) {
  const { state, actions } = useVoicePicker();
  const foreignIn = language && voiceIsForeignIn(voice, language) ? language : null;
  const isSelected = voice.id === state.selectedId;
  const isPlaying = voice.id === state.playingId;
  const isPending = voice.id === state.pendingId;
  const hasFailed = voice.id === state.failedId;

  const { data: engines } = trpc.models.engines.useQuery(undefined, { staleTime: 30_000, enabled: voice.requiresEngine !== undefined });
  const missingEngine = voiceMissingEngine(voice, engines);
  const unavailable = missingEngine !== null;
  const description = describe(voice, foreignIn);

  const status = missingEngine
    ? missingEngine
    : isPending
    ? "Generating preview — first time for this voice"
    : hasFailed
      ? "Preview failed — click to retry"
      : null;

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 rounded-md ${isSelected ? "bg-(--bg-selected)" : "hover:bg-(--bg-subtle)"}`}
    >
      <Button
        variant="icon"
        size="sm"
        onClick={() => actions.play(voice.id, foreignIn)}
        aria-busy={isPending}
        disabled={unavailable}
        className={isPending ? "cursor-progress" : ""}
        title={status ?? (isPlaying ? "Stop preview" : `Preview ${voice.label}`)}
        aria-label={isPending ? `Generating preview of ${voice.label}` : isPlaying ? `Stop preview of ${voice.label}` : `Preview ${voice.label}`}
        data-testid={`voice-preview-${voice.id}`}
      >
        {isPending ? (
          <IconSpinner className="h-3.5 w-3.5 animate-spin text-(--accent-text)" />
        ) : isPlaying ? (
          <IconPause weight="fill" className="h-3.5 w-3.5 text-(--accent-text)" />
        ) : (
          <IconPlay className="h-3.5 w-3.5 text-(--text-muted)" />
        )}
      </Button>

      <button
        type="button"
        onClick={() => actions.select(voice.id)}
        aria-pressed={isSelected}
        disabled={unavailable}
        title={missingEngine ?? undefined}
        className="flex-1 min-w-0 text-left rounded disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid={`voice-option-${voice.id}`}
      >
        <div className="text-sm text-(--text-primary) truncate" title={voice.label}>{voice.label}</div>
        <div
          title={status ?? description}
          className={`text-xs truncate ${hasFailed ? "text-(--danger-text)" : isPending ? "text-(--accent-text)" : "text-(--text-faint)"}`}
        >
          {status ?? description}
        </div>
      </button>

      <span className="text-xs font-medium text-(--text-muted) tabular-nums shrink-0">{voice.grade}</span>

      {action}

      {isSelected && (
        <IconCheck className="h-4 w-4 text-(--accent-text) shrink-0" />
      )}
    </div>
  );
});
