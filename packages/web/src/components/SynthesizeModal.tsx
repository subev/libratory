import { useMemo } from "react";

import { engineForVoiceId, getVoiceById, languageCodeFromName, normalizeVoiceId, speedRangeFor, voiceMissingEngine, voiceSupportsSpeedControl } from "../lib/voices.ts";
import { trpc } from "../trpc.ts";
import { VoicePickerProvider } from "./voice-picker/context.tsx";
import { VoiceLibraryModal } from "./voice-picker/VoiceLibraryModal.tsx";
import { SpeedSlider } from "./SpeedSlider.tsx";
import { Button } from "./Button.tsx";

// The stored voice and speed a synthesis will use, with the setters that persist them
export type SynthSettings = {
  voice: string;
  speed: number;
  onChangeVoice: (voice: string) => void;
  onChangeSpeed: (speed: number) => void;
};

// Picking a voice *is* the decision here, so this hosts the voice library directly rather than
// wrapping a control that opens a second modal on top of this one.
export function SynthesizeModal({
  count,
  language,
  bookLanguage,
  voice,
  speed,
  onChangeVoice,
  onChangeSpeed,
  costScope,
  canStart,
  disabledReason,
  onStart,
  onClose,
}: SynthSettings & {
  count: number;
  /** What Start would send: the selection (or one chapter) of the original or one variant. */
  costScope: { bookId: string; key: string | null; chapterId?: string };
  /** Variant being synthesized, by display name ("Russian"); null for the original. */
  language: string | null;
  /** The book's own language code, so an original book opens on its language, not English. */
  bookLanguage?: string | null;
  canStart: boolean;
  disabledReason?: string;
  onStart: () => void;
  onClose: () => void;
}) {
  // "Russian" is the variant's key; the picker works in codes. Stable identity — it feeds memos.
  const priorityLanguages = useMemo(() => {
    const variantCode = language ? languageCodeFromName(language) : null;
    return [...new Set([variantCode, bookLanguage].filter((c): c is string => !!c))];
  }, [language, bookLanguage]);

  // A voice saved while its engine was there (a checkout, then the desktop app on the same library)
  // must not queue chapters that can only fail
  const entry = getVoiceById(normalizeVoiceId(voice));
  const { data: engines } = trpc.models.engines.useQuery(undefined, { staleTime: 30_000, enabled: entry?.requiresEngine !== undefined });
  const voiceUnavailable = entry ? voiceMissingEngine(entry, engines) : null;
  const startable = canStart && voiceUnavailable === null;

  return (
    <VoicePickerProvider selectedId={normalizeVoiceId(voice)} onSelect={onChangeVoice}>
      <VoiceLibraryModal
        onClose={onClose}
        title={`Synthesize ${count} chapter${count === 1 ? "" : "s"}${language ? ` · ${language}` : ""}`}
        priorityLanguages={priorityLanguages}
        footer={
          <div className="px-4 py-3 space-y-3" data-testid="synthesize-modal">
            <SpeedSlider
              value={speed}
              onChange={onChangeSpeed}
              range={speedRangeFor(normalizeVoiceId(voice))}
              rangeOwner={meteredProvider(voice)}
              disabled={!voiceSupportsSpeedControl(voice)}
            />
            <div className="flex items-end justify-between gap-4">
              <div className="flex-1 space-y-1">
              <CostMeter voice={voice} scope={costScope} />
              <p className="text-xs text-(--text-muted)">
                {language
                  ? `Voice and speed are saved for the ${language} variant only — the original and other variants keep their own.`
                  : "Voice and speed are saved on the book and apply to the original audio; variants without a voice of their own follow it."}{" "}
                Chapters that already have audio keep it until re-synthesized.
              </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={onStart}
                  disabled={!startable}
                  title={voiceUnavailable ? `${entry?.label ?? voice}: ${voiceUnavailable}` : canStart ? undefined : disabledReason}
                  data-testid="synthesize-start"
                >
                  Start synthesis ({count})
                </Button>
              </div>
            </div>
          </div>
        }
      />
    </VoicePickerProvider>
  );
}

const PROVIDER_NAME = { elevenlabs: "ElevenLabs", cartesia: "Cartesia" } as const;

function meteredProvider(voice: string): string | null {
  const engine = engineForVoiceId(voice);
  return engine === "elevenlabs" || engine === "cartesia" ? PROVIDER_NAME[engine] : null;
}

// Full class names, so Tailwind sees each one
const TONE = {
  success: { bar: "bg-(--success)", text: "text-(--success-text)" },
  warning: { bar: "bg-(--warning)", text: "text-(--warning-text)" },
  danger: { bar: "bg-(--danger)", text: "text-(--danger-text)" },
} as const;

// Metered voices only: a local engine costs nothing per character, so it gets no meter at all.
// The bar is this run against what the account has left — green under half, amber up to all of
// it, red past it.
function CostMeter({ voice, scope }: { voice: string; scope: { bookId: string; key: string | null; chapterId?: string } }) {
  const provider = meteredProvider(voice);
  const { data: cost } = trpc.chapters.synthesisCost.useQuery({ ...scope, voice }, { enabled: provider !== null, staleTime: 30_000 });
  if (!provider || !cost) return null;

  const estimate = `${cost.partial ? "at least " : "≈ "}${cost.credits.toLocaleString()} credits`;
  const characters = `${cost.characters.toLocaleString()} characters`;

  if (cost.remaining === null) {
    return (
      <div className="text-xs space-y-0.5" data-testid="synthesize-cost">
        <p className="text-(--text-secondary)">
          {provider} · this run {estimate} <span className="text-(--text-faint)">({characters})</span>
        </p>
        <p className="text-(--text-faint)">Cartesia does not report the balance to an API key — check play.cartesia.ai</p>
      </div>
    );
  }

  const share = cost.remaining === 0 ? Number.POSITIVE_INFINITY : cost.credits / cost.remaining;
  const tone = TONE[share > 1 ? "danger" : share > 0.5 ? "warning" : "success"];
  const percent = Number.isFinite(share) ? `${Math.round(share * 100)}% of what is left` : "nothing is left";
  const verdict =
    share > 1
      ? `Needs ${percent} — ${(cost.credits - cost.remaining).toLocaleString()} credits short. A chapter that would not fit fails before spending anything.`
      : percent;

  return (
    <div className="text-xs space-y-1 max-w-md" data-testid="synthesize-cost">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-(--text-secondary)">
          {provider} · this run {estimate} <span className="text-(--text-faint)">({characters})</span>
        </span>
        <span className="text-(--text-muted) tabular-nums shrink-0">{cost.remaining.toLocaleString()} left</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-(--bg-subtle)"
        role="meter"
        aria-label={`${provider} credits this run would use`}
        aria-valuemin={0}
        aria-valuemax={cost.remaining}
        aria-valuenow={Math.min(cost.credits, cost.remaining)}
      >
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.min(1, share) * 100}%` }} />
      </div>
      <p className={tone.text}>{verdict}</p>
    </div>
  );
}
