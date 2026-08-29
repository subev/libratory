import { memo } from "react";

import { voiceBlockedByMissingMlx, type Voice } from "../../lib/voices.ts";
import { IconCheck, IconPause, IconPlay, IconSpinner } from "../icons.tsx";
import { trpc } from "../../trpc.ts";
import { useVoicePicker } from "./context.tsx";

function describe(voice: Voice): string {
  const parts: string[] = [];
  if (voice.gender) parts.push(voice.gender === "F" ? "Female" : "Male");
  if (voice.note) parts.push(voice.note);
  return parts.join(" · ");
}

export const VoiceRow = memo(function VoiceRow({ voice, action }: { voice: Voice; action?: React.ReactNode }) {
  const { state, actions } = useVoicePicker();
  const isSelected = voice.id === state.selectedId;
  const isPlaying = voice.id === state.playingId;
  const isPending = voice.id === state.pendingId;
  const hasFailed = voice.id === state.failedId;

  const { data: capabilities } = trpc.models.capabilities.useQuery(undefined, { staleTime: Infinity, enabled: voice.requiresMlx === true });
  const unavailable = voiceBlockedByMissingMlx(voice, capabilities?.mlx);

  const status = unavailable
    ? "Needs Apple Silicon — this narrator runs on Metal"
    : isPending
    ? "Generating preview — first time for this voice"
    : hasFailed
      ? "Preview failed — click to retry"
      : null;

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 rounded-md ${isSelected ? "bg-(--bg-selected)" : "hover:bg-(--bg-subtle)"}`}
    >
      <button
        type="button"
        onClick={() => actions.play(voice.id)}
        aria-busy={isPending}
        disabled={unavailable}
        className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center border border-(--border) transition-colors ${ isPending ? "cursor-progress" : "hover:border-(--accent) hover:bg-(--bg-selected)" }`}
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
      </button>

      <button
        type="button"
        onClick={() => actions.select(voice.id)}
        aria-pressed={isSelected}
        disabled={unavailable}
        title={unavailable ? "This narrator needs Apple's MLX, which only runs on Apple Silicon" : undefined}
        className="flex-1 min-w-0 text-left rounded disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid={`voice-option-${voice.id}`}
      >
        <div className="text-sm text-(--text-primary) truncate">{voice.label}</div>
        <div className={`text-xs truncate ${hasFailed ? "text-(--danger-text)" : isPending ? "text-(--accent-text)" : "text-(--text-faint)"}`}>
          {status ?? describe(voice)}
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
