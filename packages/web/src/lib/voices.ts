import {
  type Voice,
  type VoiceEngine,
  type VoiceGroup,
  languageOfStaticVoice,
  kokoroVoiceGroups,
  narratorVoices,
  ENGINE_PREFIXES,
  normalizeVoiceId,
  POCKET_CUSTOM_PREFIX,
} from "../../../server/src/lib/voice-catalog.ts";

export {
  type Voice,
  type VoiceEngine,
  type VoiceGroup,
  voiceCoversLanguage,
  voiceIsForeignIn,
  speedRangeFor,
  type SpeedRange,
  languageOfStaticVoice,
  kokoroVoiceGroups,
  narratorVoices,
  engineForVoiceId,
  voiceHasWordTiming,
  normalizeVoiceId,
  sayVoiceToEntry,
  cartesiaVoiceToEntry,
  elevenlabsVoiceToEntry,
  pocketVoiceToEntry,
  POCKET_CUSTOM_PREFIX,
  pocketCustomVoiceToEntry,
} from "../../../server/src/lib/voice-catalog.ts";

// Display grouping in the picker. Finer than `engine`, which lumps the Bulgarian narrators together.
export function providerOfVoice(voice: Pick<Voice, "id">): string {
  if (voice.id.startsWith("bg-")) return "Bulgarian narrators";
  if (voice.id.startsWith("pocket:")) return "Pocket TTS";
  if (voice.id.startsWith("say:")) return "macOS system";
  if (voice.id.startsWith("cartesia:")) return "Cartesia";
  if (voice.id.startsWith("elevenlabs:")) return "ElevenLabs";
  return "Kokoro";
}

export const PROVIDER_ORDER = ["Kokoro", "Pocket TTS", "Bulgarian narrators", "macOS system", "Cartesia", "ElevenLabs"];


export const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  bg: "Bulgarian",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  de: "German",
  pt: "Portuguese",
  hi: "Hindi",
  zh: "Mandarin Chinese",
  ja: "Japanese",
  ru: "Russian",
};

// Translation variants are keyed by display name ("Russian"); the picker works in codes.
export function languageCodeFromName(name: string): string | null {
  const wanted = name.trim().toLowerCase();
  const known = Object.entries(LANGUAGE_LABELS).find(([, label]) => label.toLowerCase() === wanted);
  if (known) return known[0];
  try {
    const display = new Intl.DisplayNames(["en"], { type: "language" });
    for (const code of ["ru", "uk", "pl", "nl", "tr", "sv", "da", "no", "fi", "cs", "el", "he", "ar", "ko", "ro", "hu", "hr", "sk", "th", "vi", "id", "ms"]) {
      if (display.of(code)?.toLowerCase() === wanted) return code;
    }
  } catch {
    // Intl unavailable — fall through
  }
  return null;
}

export function languageLabel(code: string): string {
  if (code === "und") return "Unknown language";
  if (LANGUAGE_LABELS[code]) return LANGUAGE_LABELS[code];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// Kokoro encodes language in the voice prefix; the narrator models are Bulgarian.
const voiceGroups: VoiceGroup[] = [
  ...kokoroVoiceGroups,
  { label: "Bulgarian", voices: narratorVoices },
];

// Static entries predate the language/engine fields; decorate them once rather than repeating
// the codes in ~50 literals.
function decorate(voice: Voice, engine: VoiceEngine): Voice {
  return { ...voice, engine, language: voice.language ?? languageOfStaticVoice(voice.id) };
}

export const staticVoices: Voice[] = [
  ...kokoroVoiceGroups.flatMap((group) => group.voices).map((v) => decorate(v, "kokoro")),
  ...narratorVoices.map((v) => decorate(v, "narrators")),
];

const voicesById = new Map(voiceGroups.flatMap((group) => group.voices).map((voice) => [voice.id, voice]));

export function getVoiceById(voiceId: string): Voice | null {
  return voicesById.get(voiceId) ?? voicesById.get(normalizeVoiceId(voiceId)) ?? null;
}

// Removed engines still name the chapters they narrated
const RETIRED_VOICE_LABELS: Record<string, string> = {
  "bg-mlx:narrator": "BG-TTS V5 (retired)",
  "kugel:default": "KugelAudio (retired)",
};

export function getVoiceLabel(voiceId: string): string {
  const voice = getVoiceById(voiceId);
  if (!voice) {
    const retired = RETIRED_VOICE_LABELS[voiceId];
    if (retired) return retired;
    if (voiceId.startsWith("say:")) return humanizeSayVoiceId(voiceId);
    if (voiceId.startsWith("cartesia:")) return `Cartesia ${voiceId.slice("cartesia:".length, "cartesia:".length + 8)}`;
    if (voiceId.startsWith("elevenlabs:")) return `ElevenLabs ${voiceId.slice("elevenlabs:".length, "elevenlabs:".length + 8)}`;
    if (voiceId.startsWith(POCKET_CUSTOM_PREFIX)) return "Cloned voice";
    if (voiceId.startsWith("pocket:")) return `${voiceId.slice("pocket:".length)} (Pocket TTS)`;
    return voiceId;
  }
  return voice.gender ? `${voice.label} (${voice.gender})` : voice.label;
}

// System voices are discovered at runtime, so stored ids may have no static entry
function humanizeSayVoiceId(voiceId: string): string {
  const words = voiceId.slice("say:".length).split("-").filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") + " (macOS)";
}

// An engine that lives in a venv of its own may not be built. Unknown means the probe has not
// answered — assume it is there rather than grey out voices on every page load and ungrey them.
const ENGINE_SETUP: Record<NonNullable<Voice["requiresEngine"]>, string> = {
  piper: "pnpm run setup",
  bgtts: "pnpm run setup --bgtts",
};

export function voiceMissingEngine(voice: Voice, installed: Partial<Record<string, boolean>> | undefined): string | null {
  if (!voice.requiresEngine || installed?.[voice.requiresEngine] !== false) return null;
  return `Not installed — run ${ENGINE_SETUP[voice.requiresEngine]}`;
}

// Runtime-discovered voices have no static entry, so the engine prefix is the fallback authority —
// a new engine must be listed in ENGINE_PREFIXES rather than defaulting to "speed works".
export function voiceSupportsSpeedControl(voiceId: string): boolean {
  const entry = getVoiceById(voiceId);
  if (entry) return entry.supportsSpeed ?? true;
  return ENGINE_PREFIXES.find((e) => voiceId.startsWith(e.prefix))?.supportsSpeed ?? true;
}
