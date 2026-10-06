import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";

type VoicePickerContextValue = {
  state: {
    selectedId: string;
    playingId: string | null;
    /** Synthesizing on the server — the first play of any voice pays for this. */
    pendingId: string | null;
    failedId: string | null;
  };
  actions: { select: (voiceId: string) => void; play: (voiceId: string, language?: string | null) => void };
};

const VoicePickerContext = createContext<VoicePickerContextValue | null>(null);

export function useVoicePicker(): VoicePickerContextValue {
  const value = use(VoicePickerContext);
  if (!value) throw new Error("useVoicePicker must be used inside <VoicePickerProvider>");
  return value;
}

export function VoicePickerProvider({
  selectedId,
  onSelect,
  children,
}: {
  selectedId: string;
  onSelect: (voiceId: string) => void;
  children: React.ReactNode;
}) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const teardown = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.remove();
    audioRef.current = null;
  }, []);

  const stop = useCallback(() => {
    teardown();
    setPlayingId(null);
    setPendingId(null);
    setFailedId(null);
  }, [teardown]);

  // Closing the picker mid-request would otherwise leave an orphaned element loading and playing.
  useEffect(() => teardown, [teardown]);

  const play = useCallback((voiceId: string, language: string | null = null) => {
    // Generation is already under way; further clicks would only restart the wait.
    if (pendingId === voiceId) return;

    const wasPlaying = playingId === voiceId;
    stop();
    if (wasPlaying) return;

    // A cold preview is synthesized on demand, so the server holds the response open for seconds
    // and play() stays pending for exactly that long — which is the signal the spinner needs.
    // Attached to the document so the app-wide exclusive-audio listener can see and pause it.
    const audio = new Audio(`/preview/${encodeURIComponent(voiceId)}${language ? `?lang=${encodeURIComponent(language)}` : ""}`);
    audio.hidden = true;
    document.body.append(audio);
    audioRef.current = audio;
    setPendingId(voiceId);

    const isCurrent = () => audioRef.current === audio;
    const fail = () => {
      if (!isCurrent()) return;
      setPendingId(null);
      setPlayingId(null);
      setFailedId(voiceId);
    };

    audio.addEventListener("ended", () => { if (isCurrent()) setPlayingId(null); });
    audio.addEventListener("error", fail);
    audio.play().then(() => {
      if (!isCurrent()) return;
      setPendingId(null);
      setPlayingId(voiceId);
    }, fail);
  }, [playingId, pendingId, stop]);

  const select = useCallback((voiceId: string) => {
    onSelect(voiceId);
    stop();
  }, [onSelect, stop]);

  const value = useMemo<VoicePickerContextValue>(
    () => ({ state: { selectedId, playingId, pendingId, failedId }, actions: { select, play } }),
    [selectedId, playingId, pendingId, failedId, select, play],
  );

  return <VoicePickerContext value={value}>{children}</VoicePickerContext>;
}
