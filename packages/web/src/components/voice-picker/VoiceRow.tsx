import { memo } from "react";

import { voiceBlockedByMissingMlx, type Voice } from "../../lib/voices.ts";
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
          <svg className="h-3.5 w-3.5 animate-spin text-(--accent-text)" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="2.5" className="opacity-25" />
            <path d="M17.5 10a7.5 7.5 0 00-7.5-7.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        ) : isPlaying ? (
          <svg className="h-3.5 w-3.5 text-(--accent-text)" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M5.75 3a.75.75 0 00-.75.75v12.5a.75.75 0 001.5 0V3.75A.75.75 0 005.75 3zM14.25 3a.75.75 0 00-.75.75v12.5a.75.75 0 001.5 0V3.75a.75.75 0 00-.75-.75z" />
          </svg>
        ) : (
          <svg className="h-3.5 w-3.5 text-(--text-muted)" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
          </svg>
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
        <svg className="h-4 w-4 text-(--accent-text) shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
        </svg>
      )}
    </div>
  );
});
