import { useMemo } from "react";

import { engineForVoiceId, languageCodeFromName, normalizeVoiceId, voiceSupportsSpeedControl } from "../lib/voices.ts";
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

  return (
    <VoicePickerProvider selectedId={normalizeVoiceId(voice)} onSelect={onChangeVoice}>
      <VoiceLibraryModal
        onClose={onClose}
        title={`Synthesize ${count} chapter${count === 1 ? "" : "s"}${language ? ` · ${language}` : ""}`}
        priorityLanguages={priorityLanguages}
        footer={
          <div className="px-4 py-3 space-y-3" data-testid="synthesize-modal">
            <SpeedSlider value={speed} onChange={onChangeSpeed} disabled={!voiceSupportsSpeedControl(voice)} />
            <div className="flex items-end justify-between gap-4">
              <div className="flex-1 space-y-1">
              <CostLine voice={voice} scope={costScope} />
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
                  disabled={!canStart}
                  title={canStart ? undefined : disabledReason}
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

// Metered voices only: a local engine costs nothing per character, so it gets no line at all.
function CostLine({ voice, scope }: { voice: string; scope: { bookId: string; key: string | null; chapterId?: string } }) {
  const engine = engineForVoiceId(voice);
  const metered = engine === "elevenlabs" || engine === "cartesia";
  const { data: cost } = trpc.chapters.synthesisCost.useQuery({ ...scope, voice }, { enabled: metered, staleTime: 30_000 });
  if (!metered || !cost) return null;

  const credits = `${cost.partial ? "at least " : "≈ "}${cost.credits.toLocaleString()} ${PROVIDER_NAME[cost.provider]} credits`;
  const over = cost.remaining !== null && cost.credits > cost.remaining;
  const balance =
    cost.remaining === null
      ? "Cartesia does not report the balance to an API key — check play.cartesia.ai"
      : over
        ? `more than the ${cost.remaining.toLocaleString()} left — a chapter that would not fit fails before spending anything`
        : `${cost.remaining.toLocaleString()} left`;
  return (
    <p className={`text-xs ${over ? "text-(--warning-text)" : "text-(--text-secondary)"}`} data-testid="synthesize-cost">
      {credits} for {cost.characters.toLocaleString()} characters · {balance}
    </p>
  );
}
