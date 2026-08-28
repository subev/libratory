import { useMemo } from "react";

import { languageCodeFromName, normalizeVoiceId, voiceSupportsSpeedControl } from "../lib/voices.ts";
import { VoicePickerProvider } from "./voice-picker/context.tsx";
import { VoiceLibraryModal } from "./voice-picker/VoiceLibraryModal.tsx";
import { SpeedSlider } from "./SpeedSlider.tsx";

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
  canStart,
  disabledReason,
  onStart,
  onClose,
}: {
  count: number;
  /** Variant being synthesized, by display name ("Russian"); null for the original. */
  language: string | null;
  /** The book's own language code, so an original book opens on its language, not English. */
  bookLanguage?: string | null;
  voice: string;
  speed: number;
  onChangeVoice: (voice: string) => void;
  onChangeSpeed: (speed: number) => void;
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
              <p className="text-xs text-(--text-muted) flex-1">
                {language
                  ? `Voice and speed are saved for the ${language} variant only — the original and other variants keep their own.`
                  : "Voice and speed are saved on the book and apply to the original audio; variants without a voice of their own follow it."}{" "}
                Chapters that already have audio keep it until re-synthesized.
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-md text-sm font-medium border border-(--border-input) text-(--text-secondary) hover:bg-(--bg-subtle) focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onStart}
                  disabled={!canStart}
                  title={canStart ? undefined : disabledReason}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-(--accent) text-(--on-accent) disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-(--focus-ring) focus-visible:outline-none"
                  data-testid="synthesize-start"
                >
                  Start synthesis ({count})
                </button>
              </div>
            </div>
          </div>
        }
      />
    </VoicePickerProvider>
  );
}
