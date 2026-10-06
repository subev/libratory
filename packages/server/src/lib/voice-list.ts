import { voiceHasWordTiming } from "./voice-catalog.ts";
import {
  cartesiaVoiceToEntry,
  elevenlabsVoiceToEntry,
  kokoroVoiceGroups,
  languageOfStaticVoice,
  narratorVoices,
  pocketCustomVoiceToEntry,
  pocketVoiceToEntry,
  sayVoiceToEntry,
  voiceCoversLanguage,
  voiceIsForeignIn,
  type Voice,
  type VoiceEngine,
} from "./voice-catalog.ts";
import { listSayVoices } from "./say-voices.ts";
import { listCartesiaVoices } from "./cartesia.ts";
import { listElevenLabsVoices } from "./elevenlabs.ts";
import { listCustomPocketVoices } from "./pocket-voices.ts";
import { POCKET_VOICES } from "./pocket.ts";
import { installedLocalEngines } from "./tts.ts";
import { listPocketLanguages } from "./pocket-languages.ts";

export type ListedVoice = {
  id: string;
  label: string;
  language: string;
  gender: "F" | "M" | null;
  engine: VoiceEngine;
  cloud: boolean;
  supportsSpeed: boolean;
  // A time for every word in the recording, or chunk boundaries only (sentence level)
  wordTiming: boolean;
  // Against the language filtered by: false when the voice reads it in another language's accent
  native: boolean | null;
  note: string | null;
};

const CLOUD_ENGINES = new Set<VoiceEngine>(["cartesia", "elevenlabs"]);

function listed(voice: Voice, engine: VoiceEngine, language: string | undefined): ListedVoice {
  return {
    id: voice.id,
    label: voice.label,
    language: voice.language ?? languageOfStaticVoice(voice.id),
    gender: voice.gender,
    engine,
    cloud: CLOUD_ENGINES.has(engine),
    supportsSpeed: voice.supportsSpeed ?? true,
    wordTiming: voiceHasWordTiming(voice.id, voice.language ?? languageOfStaticVoice(voice.id)),
    note: voice.note ?? null,
    native: language === undefined ? null : !voiceIsForeignIn(voice, language),
  };
}

// Everything the picker would show, in one flat list: the static catalog plus the engines that
// only answer at runtime — installed macOS voices, Pocket languages on disk, cloud libraries
// behind a configured key. Each live source fails on its own so one dead API costs its voices, not the list.
// A voice whose engine env was never built is left out, as an undownloaded Pocket language is.
export async function listAllVoices(filter: { language?: string; engine?: VoiceEngine } = {}): Promise<ListedVoice[]> {
  const settle = async <T,>(run: () => Promise<T[]>): Promise<T[]> => run().catch(() => []);
  const [say, cartesia, elevenlabs, customPocket, pocketLanguages] = await Promise.all([
    settle(listSayVoices),
    settle(listCartesiaVoices),
    settle(listElevenLabsVoices),
    settle(listCustomPocketVoices),
    settle(listPocketLanguages),
  ]);

  // Static entries carry no language of their own; it is filled in before the language filter runs
  const tagged = (engine: VoiceEngine) => (voice: Voice) => ({
    voice: { ...voice, language: voice.language ?? languageOfStaticVoice(voice.id) },
    engine,
  });
  const voices = [
    ...kokoroVoiceGroups.flatMap((g) => g.voices).map(tagged("kokoro")),
    ...narratorVoices.map(tagged("narrators")),
    ...pocketLanguages
      .filter((l) => l.installed)
      .flatMap((l) => POCKET_VOICES.map((v) => pocketVoiceToEntry(v, l.code)))
      .map(tagged("pocket")),
    ...customPocket.map(pocketCustomVoiceToEntry).map(tagged("pocket")),
    ...say.map(sayVoiceToEntry).map(tagged("say")),
    ...cartesia.map(cartesiaVoiceToEntry).map(tagged("cartesia")),
    ...elevenlabs.map(elevenlabsVoiceToEntry).map(tagged("elevenlabs")),
  ];

  const engines = installedLocalEngines();
  const { language } = filter;
  return voices
    .filter(
      ({ voice, engine }) =>
        (voice.requiresEngine === undefined || engines[voice.requiresEngine]) &&
        (filter.engine === undefined || engine === filter.engine) &&
        (language === undefined || voiceCoversLanguage(voice, language)),
    )
    .map(({ voice, engine }) => listed(voice, engine, language));
}
