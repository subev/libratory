import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PillToggle } from "../PillToggle.tsx";

const READING_SCRIPT =
  "The morning light came in sideways through the tall windows, and for a moment nobody spoke. " +
  "She turned the page slowly, weighing what to say next. Was it really the same house? " +
  "It had to be — the same crooked staircase, the same smell of rain on old wood. " +
  "Twenty years, and nothing had moved at all.";

const MIN_SECONDS = 8;
const TARGET_SECONDS = 20;

type Props = { onAdded: () => void };

export function PocketVoiceCloner({ onAdded }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"upload" | "record">("record");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [recorded, setRecorded] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  const recordedUrl = useMemo(() => (recorded ? URL.createObjectURL(recorded) : null), [recorded]);
  useEffect(() => () => { if (recordedUrl) URL.revokeObjectURL(recordedUrl); }, [recordedUrl]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        setRecorded(new Blob(chunks, { type: recorder.mimeType }));
        stream.getTracks().forEach((track) => track.stop());
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecorded(null);
      setElapsed(0);
      setRecording(true);
      timerRef.current = setInterval(() => setElapsed((value) => value + 0.1), 100);
    } catch {
      setError("Could not access the microphone. Mic capture needs localhost or HTTPS, and permission in the browser.");
    }
  }, []);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    stopTimer();
    setRecording(false);
  }, [stopTimer]);

  const reset = useCallback(() => {
    setName("");
    setConsent(false);
    setFile(null);
    setRecorded(null);
    setElapsed(0);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    const audio = mode === "record" ? recorded : file;
    if (!audio) return;

    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", audio, mode === "record" ? "recording.webm" : (file as File).name);
      body.append("name", name);
      body.append("consent", String(consent));
      const response = await fetch("/upload/pocket-voice", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Voice import failed");
      reset();
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Voice import failed");
    } finally {
      setBusy(false);
    }
  }, [mode, recorded, file, name, consent, reset, onAdded]);

  const hasAudio = mode === "record" ? recorded !== null : file !== null;
  const tooShort = mode === "record" && recorded !== null && elapsed < MIN_SECONDS;
  const canSubmit = hasAudio && consent && !busy && !recording && !tooShort;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full px-3 py-2 text-sm text-left text-(--text-secondary) hover:bg-(--bg-subtle) border-t border-(--border)"
        data-testid="pocket-clone-open"
      >
        + Add your own voice
      </button>
    );
  }

  return (
    <div className="px-3 py-3 border-t border-(--border) space-y-3" data-testid="pocket-clone-panel">
      <div className="text-xs text-(--text-muted) space-y-1">
        <p className="font-semibold text-(--text-secondary)">For the best clone</p>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>Read for about {TARGET_SECONDS} seconds in a quiet room — {MIN_SECONDS}s minimum</li>
          <li>Use a headset mic rather than the laptop's, and keep a steady distance</li>
          <li>Read with normal expression; a flat voice clones flat</li>
          <li>The sample's audio quality is reproduced — room echo and hiss get cloned too</li>
          <li>On iPhone, Voice Memos with <strong>Studio</strong> quality gives a noticeably cleaner sample</li>
        </ul>
      </div>

      <div className="flex gap-1">
        {(["record", "upload"] as const).map((id) => (
          <PillToggle key={id} selected={mode === id} onClick={() => setMode(id)}>
            {id === "record" ? "Record" : "Upload a file"}
          </PillToggle>
        ))}
      </div>

      {mode === "record" ? (
        <div className="space-y-2">
          <p className="text-xs text-(--text-muted) italic leading-relaxed bg-(--bg-subtle) p-2 rounded">
            {READING_SCRIPT}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={recording ? stopRecording : startRecording}
              disabled={busy}
              className={`px-3 py-1.5 text-sm rounded ${
                recording ? "bg-(--danger) text-(--on-danger)" : "bg-(--bg-subtle) text-(--text-secondary) border border-(--border)"
              } disabled:opacity-50`}
              data-testid="pocket-clone-record"
            >
              {recording ? "Stop" : recorded ? "Record again" : "Start recording"}
            </button>
            <span
              className={`text-sm tabular-nums ${elapsed >= MIN_SECONDS ? "text-(--success-text)" : "text-(--text-muted)"}`}
              data-testid="pocket-clone-timer"
            >
              {elapsed.toFixed(1)}s
            </span>
            {recordedUrl && !recording && (
              <audio controls src={recordedUrl ?? undefined} className="h-8 flex-1 min-w-0" />
            )}
          </div>
          {tooShort && (
            <p className="text-xs text-(--warning-text)">Too short — record at least {MIN_SECONDS} seconds.</p>
          )}
        </div>
      ) : (
        <input
          type="file"
          accept="audio/*,video/*"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="block w-full text-xs text-(--text-secondary)"
          data-testid="pocket-clone-file"
        />
      )}

      <input
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Voice name"
        className="w-full rounded-md border border-(--border-input) bg-(--bg-input) px-2 py-1.5 text-sm"
        data-testid="pocket-clone-name"
      />

      <label className="flex items-start gap-2 text-xs text-(--text-muted)">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5"
          data-testid="pocket-clone-consent"
        />
        <span>
          This is my own voice, or I have the speaker's explicit permission to clone it. Kyutai's terms
          prohibit cloning anyone's voice without their consent.
        </span>
      </label>

      {error && <p className="text-xs text-(--danger-text)" data-testid="pocket-clone-error">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          title={
            !hasAudio ? "Record or upload a sample first"
              : !consent ? "Confirm you have the speaker's consent"
              : tooShort ? `Recording must be at least ${MIN_SECONDS} seconds`
              : undefined
          }
          className="px-3 py-1.5 text-sm rounded bg-(--accent) text-(--on-accent) disabled:opacity-50"
          data-testid="pocket-clone-submit"
        >
          {busy ? "Encoding..." : "Add voice"}
        </button>
        <button
          type="button"
          onClick={() => { reset(); setOpen(false); }}
          className="px-3 py-1.5 text-sm rounded border border-(--border) text-(--text-secondary)"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
