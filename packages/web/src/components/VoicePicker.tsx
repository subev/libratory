import { useCallback, useMemo, useRef, useState } from "react";

import { Button } from "./Button.tsx";
import { IconMicrophone } from "./icons.tsx";
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
  /** Codes to pin at the top of the library — the language this book will be read in. */
  priorityLanguages?: string[];
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

function useVoiceLibrary(value: string, onChange: (voice: string) => void, priorityLanguages: string[]) {
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
      <VoiceLibraryModal onClose={close} priorityLanguages={priorityLanguages} />
    </VoicePickerProvider>
  ) : null;

  return { open: () => setIsOpen(true), triggerRef, label, library };
}

const NO_PRIORITY: string[] = [];

export function VoicePicker({ value, onChange, title, priorityLanguages = NO_PRIORITY }: VoicePickerProps) {
  const { open, triggerRef, label, library } = useVoiceLibrary(value, onChange, priorityLanguages);

  return (
    <div className="relative flex-1">
      <label className="block text-sm font-medium text-(--text-secondary) mb-1" htmlFor="voice-picker-trigger">Voice</label>
      {/* button-ok: a labelled form control, skinned to match the text input beside it, not an action */}
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
      <Button
        variant="secondary"
        size="sm"
        ref={triggerRef}
        onClick={open}
        title={title}
        aria-haspopup="dialog"
        aria-label={`Voice: ${label}`}
        data-testid="voice-picker-trigger"
      >
        {/* A chevron promised a dropdown; this opens a modal, so it reads as a button instead. */}
        <IconMicrophone className="h-3.5 w-3.5 shrink-0 text-(--text-faint)" />
        <span className="text-(--text-faint)">Voice</span>
        <span className="truncate max-w-56">{label}</span>
      </Button>
      {library}
    </div>
  );
}
