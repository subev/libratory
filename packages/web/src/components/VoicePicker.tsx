import { useCallback, useMemo, useRef, useState } from "react";

import { TOOLBAR_BUTTON } from "../lib/button-classes.ts";
import {
  cartesiaVoiceToEntry,
  elevenlabsVoiceToEntry,
  engineForVoiceId,
  getVoiceLabel,
  normalizeVoiceId,
  pocketCustomVoiceToEntry,
  pocketVoiceToEntry,
  sayVoiceToEntry,
  type Voice,
} from "../lib/voices.ts";
import { trpc } from "../trpc.ts";
import { VoicePickerProvider } from "./voice-picker/context.tsx";
import { VoiceLibraryModal } from "./voice-picker/VoiceLibraryModal.tsx";

type VoicePickerProps = {
  value: string;
  onChange: (voice: string) => void;
  title?: string;
};

// Only the engine owning the current selection is queried — the modal loads the rest on demand.
function useSelectedVoiceLabel(selectedId: string): string {
  const engine = engineForVoiceId(selectedId);
  const { data: sayVoices = [] } = trpc.sayVoices.list.useQuery(undefined, { staleTime: Infinity, enabled: engine === "say" });
  const { data: cartesiaVoices = [] } = trpc.cartesiaVoices.list.useQuery(undefined, { staleTime: Infinity, enabled: engine === "cartesia" });
  const { data: elevenlabsVoices = [] } = trpc.elevenlabsVoices.list.useQuery(undefined, { staleTime: Infinity, enabled: engine === "elevenlabs" });
  const { data: pocket } = trpc.pocketVoices.list.useQuery(undefined, { staleTime: Infinity, enabled: engine === "pocket" });

  return useMemo(() => {
    const candidates: Voice[] =
      engine === "say" ? sayVoices.map(sayVoiceToEntry)
      : engine === "cartesia" ? cartesiaVoices.map(cartesiaVoiceToEntry)
      : engine === "elevenlabs" ? elevenlabsVoices.map(elevenlabsVoiceToEntry)
      : engine === "pocket" ? [
          ...(pocket?.custom ?? []).map(pocketCustomVoiceToEntry),
          ...(pocket?.voices ?? []).map((voice) => pocketVoiceToEntry(voice, pocketLanguageOf(selectedId))),
        ]
      : [];
    return candidates.find((voice) => voice.id === selectedId)?.label ?? getVoiceLabel(selectedId);
  }, [selectedId, engine, sayVoices, cartesiaVoices, elevenlabsVoices, pocket]);
}

// `pocket:it:giovanni` — the middle segment is the language; bare and `custom:` ids are English.
function pocketLanguageOf(voiceId: string): string {
  const rest = voiceId.slice("pocket:".length);
  const separator = rest.indexOf(":");
  if (separator === -1) return "en";
  const code = rest.slice(0, separator);
  return code === "custom" ? "en" : code;
}

function useVoiceLibrary(value: string, onChange: (voice: string) => void) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedId = normalizeVoiceId(value);
  const label = useSelectedVoiceLabel(selectedId);

  const close = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  const library = isOpen ? (
    <VoicePickerProvider selectedId={selectedId} onSelect={onChange}>
      <VoiceLibraryModal onClose={close} />
    </VoicePickerProvider>
  ) : null;

  return { open: () => setIsOpen(true), triggerRef, label, library };
}

export function VoicePicker({ value, onChange, title }: VoicePickerProps) {
  const { open, triggerRef, label, library } = useVoiceLibrary(value, onChange);

  return (
    <div className="relative flex-1">
      <label className="block text-sm font-medium text-(--text-secondary) mb-1" htmlFor="voice-picker-trigger">Voice</label>
      <button
        id="voice-picker-trigger"
        ref={triggerRef}
        type="button"
        onClick={open}
        title={title}
        aria-haspopup="dialog"
        className="w-full flex items-center justify-between rounded-md border border-(--border-input) bg-(--bg-input) px-3 py-2 text-sm shadow-sm hover:border-(--text-faint)"
        data-testid="voice-picker-trigger"
      >
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-xs font-medium text-(--accent-text)">Change</span>
      </button>
      {library}
    </div>
  );
}

export function VoicePickerChip({ value, onChange, title }: VoicePickerProps) {
  const { open, triggerRef, label, library } = useVoiceLibrary(value, onChange);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={open}
        title={title}
        aria-haspopup="dialog"
        aria-label={`Voice: ${label}`}
        className={`${TOOLBAR_BUTTON} flex items-center gap-1.5`}
        data-testid="voice-picker-trigger"
      >
        {/* A chevron promised a dropdown; this opens a modal, so it reads as a button instead. */}
        <svg className="h-3.5 w-3.5 shrink-0 text-(--text-faint)" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M10 2.75a1.25 1.25 0 00-1.25 1.25v6a1.25 1.25 0 002.5 0v-6A1.25 1.25 0 0010 2.75z" />
          <path d="M5.5 9.25a.75.75 0 00-1.5 0 6 6 0 005.25 5.954V17h-2a.75.75 0 000 1.5h5.5a.75.75 0 000-1.5h-2v-1.796A6 6 0 0016 9.25a.75.75 0 00-1.5 0 4.5 4.5 0 01-9 0z" />
        </svg>
        <span className="text-(--text-faint)">Voice</span>
        <span className="truncate max-w-56">{label}</span>
      </button>
      {library}
    </div>
  );
}
