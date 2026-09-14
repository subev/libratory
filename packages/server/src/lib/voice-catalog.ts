// The voice catalog, dependency-free so both the web picker and the server (MCP list_voices,
// previews) read one table. Runtime-discovered engines have no entries here; their converters do.
export type Voice = {
  id: string;
  label: string;
  gender: "F" | "M" | null;
  grade: string;
  supportsSpeed?: boolean;
  note?: string;
  /** ISO-639-1 code the voice actually reads; MULTILINGUAL for models that cover many. */
  language?: string;
  /** Which engine provides it — the secondary grouping in the picker. */
  engine?: VoiceEngine;
  /** Set when the voice cannot run without Apple's MLX, so a non-Metal machine can say why. */
  requiresMlx?: boolean;
};

export const MULTILINGUAL = "multi";

// KugelAudio reads many languages but not *any* language, and nothing recorded which — so it was
// offered under Hindi and Mandarin, which it cannot speak. These are the EU's 24 official languages.
const MULTILINGUAL_LANGUAGES = new Set([
  "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "ga", "hr",
  "hu", "it", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "sk", "sl", "sv",
]);

// The one predicate behind both the sidebar counts and the list itself; when they disagreed, the
// rail said 48 and the provider chips added up to 49.
export function voiceCoversLanguage(voice: Pick<Voice, "language">, code: string): boolean {
  const language = voice.language ?? "en";
  return language === code || (language === MULTILINGUAL && MULTILINGUAL_LANGUAGES.has(code));
}

export const KOKORO_LANGUAGE_BY_PREFIX: Record<string, string> = {
  a: "en", b: "en", e: "es", f: "fr", h: "hi", i: "it", p: "pt", z: "zh", j: "ja",
};

export function languageOfStaticVoice(voiceId: string): string {
  if (voiceId.startsWith("kugel:")) return MULTILINGUAL;
  if (voiceId.startsWith("bg-")) return "bg";
  if (voiceId.startsWith("kokoro:")) {
    return KOKORO_LANGUAGE_BY_PREFIX[voiceId.charAt("kokoro:".length)] ?? "en";
  }
  return "en";
}

export type VoiceGroup = {
  label: string;
  voices: Voice[];
};

export const kokoroVoiceGroups: VoiceGroup[] = [
  {
    label: "American English",
    voices: [
      { id: "kokoro:af_heart", label: "Heart", gender: "F", grade: "A", supportsSpeed: true },
      { id: "kokoro:af_bella", label: "Bella", gender: "F", grade: "A-", supportsSpeed: true },
      { id: "kokoro:af_nicole", label: "Nicole", gender: "F", grade: "B-", supportsSpeed: true },
      { id: "kokoro:af_aoede", label: "Aoede", gender: "F", grade: "C+", supportsSpeed: true },
      { id: "kokoro:af_kore", label: "Kore", gender: "F", grade: "C+", supportsSpeed: true },
      { id: "kokoro:af_sarah", label: "Sarah", gender: "F", grade: "C+", supportsSpeed: true },
      { id: "kokoro:af_alloy", label: "Alloy", gender: "F", grade: "C", supportsSpeed: true },
      { id: "kokoro:af_nova", label: "Nova", gender: "F", grade: "C", supportsSpeed: true },
      { id: "kokoro:af_sky", label: "Sky", gender: "F", grade: "C-", supportsSpeed: true },
      { id: "kokoro:af_jessica", label: "Jessica", gender: "F", grade: "D", supportsSpeed: true },
      { id: "kokoro:af_river", label: "River", gender: "F", grade: "D", supportsSpeed: true },
      { id: "kokoro:am_fenrir", label: "Fenrir", gender: "M", grade: "C+", supportsSpeed: true },
      { id: "kokoro:am_michael", label: "Michael", gender: "M", grade: "C+", supportsSpeed: true },
      { id: "kokoro:am_puck", label: "Puck", gender: "M", grade: "C+", supportsSpeed: true },
      { id: "kokoro:am_echo", label: "Echo", gender: "M", grade: "D", supportsSpeed: true },
      { id: "kokoro:am_eric", label: "Eric", gender: "M", grade: "D", supportsSpeed: true },
      { id: "kokoro:am_liam", label: "Liam", gender: "M", grade: "D", supportsSpeed: true },
      { id: "kokoro:am_onyx", label: "Onyx", gender: "M", grade: "D", supportsSpeed: true },
      { id: "kokoro:am_adam", label: "Adam", gender: "M", grade: "F+", supportsSpeed: true },
    ],
  },
  {
    label: "British English",
    voices: [
      { id: "kokoro:bf_emma", label: "Emma", gender: "F", grade: "B-", supportsSpeed: true },
      { id: "kokoro:bf_isabella", label: "Isabella", gender: "F", grade: "C", supportsSpeed: true },
      { id: "kokoro:bf_alice", label: "Alice", gender: "F", grade: "D", supportsSpeed: true },
      { id: "kokoro:bf_lily", label: "Lily", gender: "F", grade: "D", supportsSpeed: true },
      { id: "kokoro:bm_george", label: "George", gender: "M", grade: "C", supportsSpeed: true },
      { id: "kokoro:bm_fable", label: "Fable", gender: "M", grade: "C", supportsSpeed: true },
      { id: "kokoro:bm_lewis", label: "Lewis", gender: "M", grade: "D+", supportsSpeed: true },
      { id: "kokoro:bm_daniel", label: "Daniel", gender: "M", grade: "D", supportsSpeed: true },
    ],
  },
  {
    label: "French",
    voices: [{ id: "kokoro:ff_siwis", label: "Siwis", gender: "F", grade: "B-", supportsSpeed: true }],
  },
  {
    label: "Spanish",
    voices: [
      { id: "kokoro:ef_dora", label: "Dora", gender: "F", grade: "C", supportsSpeed: true },
      { id: "kokoro:em_alex", label: "Alex", gender: "M", grade: "C", supportsSpeed: true },
    ],
  },
  {
    label: "Italian",
    voices: [
      { id: "kokoro:if_sara", label: "Sara", gender: "F", grade: "B", supportsSpeed: true },
      { id: "kokoro:im_nicola", label: "Nicola", gender: "M", grade: "B", supportsSpeed: true },
    ],
  },
  {
    label: "Brazilian Portuguese",
    voices: [
      { id: "kokoro:pf_dora", label: "Dora", gender: "F", grade: "C", supportsSpeed: true },
      { id: "kokoro:pm_alex", label: "Alex", gender: "M", grade: "C", supportsSpeed: true },
    ],
  },
  {
    label: "Hindi",
    voices: [
      { id: "kokoro:hf_alpha", label: "Alpha", gender: "F", grade: "B", supportsSpeed: true },
      { id: "kokoro:hf_beta", label: "Beta", gender: "F", grade: "B", supportsSpeed: true },
      { id: "kokoro:hm_omega", label: "Omega", gender: "M", grade: "B", supportsSpeed: true },
      { id: "kokoro:hm_psi", label: "Psi", gender: "M", grade: "B", supportsSpeed: true },
    ],
  },
  {
    label: "Mandarin Chinese",
    voices: [
      { id: "kokoro:zf_xiaobei", label: "Xiaobei", gender: "F", grade: "D", supportsSpeed: true },
      { id: "kokoro:zf_xiaoni", label: "Xiaoni", gender: "F", grade: "D", supportsSpeed: true },
      { id: "kokoro:zf_xiaoxiao", label: "Xiaoxiao", gender: "F", grade: "D", supportsSpeed: true },
      { id: "kokoro:zf_xiaoyi", label: "Xiaoyi", gender: "F", grade: "D", supportsSpeed: true },
      { id: "kokoro:zm_yunjian", label: "Yunjian", gender: "M", grade: "D", supportsSpeed: true },
      { id: "kokoro:zm_yunxi", label: "Yunxi", gender: "M", grade: "D", supportsSpeed: true },
      { id: "kokoro:zm_yunxia", label: "Yunxia", gender: "M", grade: "D", supportsSpeed: true },
      { id: "kokoro:zm_yunyang", label: "Yunyang", gender: "M", grade: "D", supportsSpeed: true },
    ],
  },
];

export const narratorVoices: Voice[] = [
  { id: "bg-mlx:narrator", label: "BG-TTS V5 (Radi Totev MLX port)", gender: null, grade: "MLX", supportsSpeed: false, note: "Apple Silicon narrator", requiresMlx: true },
  { id: "bg-mms:bul", label: "MMS Bulgarian (Meta)", gender: null, grade: "VITS", supportsSpeed: false, note: "Meta MMS" },
  { id: "kugel:default", label: "KugelAudio (7B, 24 EU languages)", gender: null, grade: "MLX", supportsSpeed: false, note: "Multilingual narrator", requiresMlx: true },
];

export type VoiceEngine = "kokoro" | "narrators" | "say" | "cartesia" | "elevenlabs" | "pocket";

export const ENGINE_PREFIXES: { prefix: string; engine: VoiceEngine; supportsSpeed: boolean }[] = [
  { prefix: "say:", engine: "say", supportsSpeed: true },
  { prefix: "cartesia:", engine: "cartesia", supportsSpeed: true },
  { prefix: "elevenlabs:", engine: "elevenlabs", supportsSpeed: true },
  { prefix: "pocket:", engine: "pocket", supportsSpeed: false },
  { prefix: "bg-", engine: "narrators", supportsSpeed: false },
  { prefix: "kugel:", engine: "narrators", supportsSpeed: false },
];

export function engineForVoiceId(voiceId: string): VoiceEngine {
  return ENGINE_PREFIXES.find((entry) => voiceId.startsWith(entry.prefix))?.engine ?? "kokoro";
}

export function normalizeVoiceId(voiceId: string): string {
  return voiceId.includes(":") ? voiceId : `kokoro:${voiceId}`;
}

export function sayVoiceToEntry(voice: { slug: string; name: string; locale: string }): Voice {
  return {
    id: `say:${voice.slug}`,
    label: voice.name,
    gender: null,
    grade: "OS",
    supportsSpeed: true,
    note: voice.locale,
    language: voice.locale.split(/[_-]/)[0]?.toLowerCase() ?? "",
    engine: "say",
  };
}

export function cartesiaVoiceToEntry(voice: { id: string; name: string; language: string; gender: string | null; tagline: string }): Voice {
  return {
    id: `cartesia:${voice.id}`,
    label: voice.name,
    gender: voice.gender === "masculine" ? "M" : voice.gender === "feminine" ? "F" : null,
    grade: "API",
    supportsSpeed: true,
    note: voice.tagline || voice.language,
    language: voice.language.split(/[_-]/)[0]?.toLowerCase() ?? "",
    engine: "cartesia",
  };
}

export function elevenlabsVoiceToEntry(voice: { id: string; name: string; language: string; gender: string | null; tagline: string }): Voice {
  return {
    id: `elevenlabs:${voice.id}`,
    label: voice.name,
    gender: voice.gender === "male" ? "M" : voice.gender === "female" ? "F" : null,
    grade: "API",
    supportsSpeed: true,
    note: voice.tagline || voice.language,
    language: voice.language.split(/[_-]/)[0]?.toLowerCase() ?? "",
    engine: "elevenlabs",
  };
}

// English keeps the bare `pocket:<voice>` form so ids stored before languages existed still resolve.
export function pocketVoiceToEntry(
  voice: { id: string; name: string; license: string; note: string },
  languageCode = "en",
): Voice {
  return {
    id: languageCode === "en" ? `pocket:${voice.id}` : `pocket:${languageCode}:${voice.id}`,
    label: voice.name,
    gender: null,
    grade: "CPU",
    supportsSpeed: false,
    note: `${voice.note} \u00b7 ${voice.license}`,
    language: languageCode,
    engine: "pocket",
  };
}

export const POCKET_CUSTOM_PREFIX = "pocket:custom:";

export function pocketCustomVoiceToEntry(voice: { id: string; name: string; seconds: number }): Voice {
  return {
    id: `${POCKET_CUSTOM_PREFIX}${voice.id}`,
    label: voice.name,
    gender: null,
    grade: "Cloned",
    supportsSpeed: false,
    note: `${voice.seconds}s reference`,
    language: "en",
    engine: "pocket",
  };
}
