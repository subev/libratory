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
  type Voice,
  type VoiceEngine,
} from "./voice-catalog.ts";
import { listSayVoices } from "./say-voices.ts";
import { listCartesiaVoices } from "./cartesia.ts";
import { listElevenLabsVoices } from "./elevenlabs.ts";
import { listCustomPocketVoices } from "./pocket-voices.ts";
import { POCKET_VOICES } from "./pocket.ts";
import { listPocketLanguages } from "./pocket-languages.ts";

export type ListedVoice = {
  id: string;
  label: string;
  language: string;
  gender: "F" | "M" | null;
  engine: VoiceEngine;
  cloud: boolean;
  supportsSpeed: boolean;
  requiresMlx: boolean;
  note: string | null;
};

const CLOUD_ENGINES = new Set<VoiceEngine>(["cartesia", "elevenlabs"]);

function listed(voice: Voice, engine: VoiceEngine): ListedVoice {
  return {
    id: voice.id,
    label: voice.label,
    language: voice.language ?? languageOfStaticVoice(voice.id),
    gender: voice.gender,
    engine,
    cloud: CLOUD_ENGINES.has(engine),
    supportsSpeed: voice.supportsSpeed ?? true,
    requiresMlx: voice.requiresMlx === true,
    note: voice.note ?? null,
  };
}

// Everything the picker would show, in one flat list: the static catalog plus the engines that
// only answer at runtime — installed macOS voices, Pocket languages on disk, cloud libraries
// behind a configured key. Each live source fails on its own so one dead API costs its voices, not the list.
export async function listAllVoices(filter: { language?: string; engine?: VoiceEngine } = {}): Promise<ListedVoice[]> {
  const settle = async <T,>(run: () => Promise<T[]>): Promise<T[]> => run().catch(() => []);
  const [say, cartesia, elevenlabs, customPocket, pocketLanguages] = await Promise.all([
    settle(listSayVoices),
    settle(listCartesiaVoices),
    settle(listElevenLabsVoices),
    settle(listCustomPocketVoices),
    settle(listPocketLanguages),
  ]);

  const voices: ListedVoice[] = [
    ...kokoroVoiceGroups.flatMap((g) => g.voices).map((v) => listed(v, "kokoro")),
    ...narratorVoices.map((v) => listed(v, "narrators")),
    ...pocketLanguages
      .filter((l) => l.installed)
      .flatMap((l) => POCKET_VOICES.map((v) => listed(pocketVoiceToEntry(v, l.code), "pocket"))),
    ...customPocket.map((v) => listed(pocketCustomVoiceToEntry(v), "pocket")),
    ...say.map((v) => listed(sayVoiceToEntry(v), "say")),
    ...cartesia.map((v) => listed(cartesiaVoiceToEntry(v), "cartesia")),
    ...elevenlabs.map((v) => listed(elevenlabsVoiceToEntry(v), "elevenlabs")),
  ];

  return voices.filter(
    (v) =>
      (filter.engine === undefined || v.engine === filter.engine) &&
      (filter.language === undefined || voiceCoversLanguage(v, filter.language)),
  );
}
