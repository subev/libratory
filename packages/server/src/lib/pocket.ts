import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { env } from "../env.ts";
import { pocketVoicesDir, scriptPath } from "./paths.ts";

export const POCKET_SCRIPT = scriptPath("synthesize_pocket_tts.py");
export const pocketPython = () => path.join(env.POCKET_ENV_PATH, "python");

export type PocketLanguage = {
  /** Short code used in voice ids: `pocket:<code>:<voice>` (English is implicit, `pocket:<voice>`). */
  code: string;
  label: string;
  /** pocket-tts config name — the checkpoint, not a runtime switch. */
  model: string;
  approxMb: number;
  /** Rough throughput on CPU; the 24-layer previews are markedly slower than the distilled ones. */
  realtimeFactor: number;
  note?: string;
};

// Kyutai ships one checkpoint per language. The "_24l" builds are 24-layer previews (641 MB of
// weights vs 209 MB) and upstream flags them as not-yet-distilled; French has no distilled build.
const ENGLISH: PocketLanguage = { code: "en", label: "English", model: "english", approxMb: 370, realtimeFactor: 12 };

export const POCKET_LANGUAGES: PocketLanguage[] = [
  ENGLISH,
  { code: "es", label: "Spanish", model: "spanish", approxMb: 370, realtimeFactor: 12 },
  { code: "it", label: "Italian", model: "italian", approxMb: 370, realtimeFactor: 12 },
  { code: "de", label: "German", model: "german", approxMb: 370, realtimeFactor: 12 },
  { code: "pt", label: "Portuguese", model: "portuguese", approxMb: 370, realtimeFactor: 12 },
  { code: "fr", label: "French", model: "french_24l", approxMb: 800, realtimeFactor: 5, note: "Preview model — larger and ~2.5x slower; Kyutai has no distilled French build yet" },
];

export const DEFAULT_POCKET_LANGUAGE = ENGLISH;

export function pocketLanguageByCode(code: string): PocketLanguage | null {
  return POCKET_LANGUAGES.find((l) => l.code === code) ?? null;
}

export type PocketVoiceLicense = "CC0" | "CC BY 4.0" | "CC BY-NC 4.0" | "unverified";

export type PocketVoice = {
  id: string;
  name: string;
  license: PocketVoiceLicense;
  note: string;
};

// Licenses come from the voices' source datasets, mapped in pocket_tts/utils/utils.py
// (_ORIGINS_OF_PREDEFINED_VOICES) — see docs/tts-licensing.md before any paid deployment.
export const POCKET_VOICES: PocketVoice[] = [
  { id: "alba", name: "Alba", license: "CC BY 4.0", note: "Voice-acted" },
  { id: "anna", name: "Anna", license: "CC BY 4.0", note: "VCTK" },
  { id: "vera", name: "Vera", license: "CC BY 4.0", note: "VCTK" },
  { id: "fantine", name: "Fantine", license: "CC BY 4.0", note: "VCTK" },
  { id: "charles", name: "Charles", license: "CC BY 4.0", note: "VCTK" },
  { id: "paul", name: "Paul", license: "CC BY 4.0", note: "VCTK" },
  { id: "eponine", name: "Eponine", license: "CC BY 4.0", note: "VCTK" },
  { id: "azelma", name: "Azelma", license: "CC BY 4.0", note: "VCTK" },
  { id: "george", name: "George", license: "CC BY 4.0", note: "VCTK" },
  { id: "mary", name: "Mary", license: "CC BY 4.0", note: "VCTK" },
  { id: "jane", name: "Jane", license: "CC BY 4.0", note: "VCTK" },
  { id: "michael", name: "Michael", license: "CC BY 4.0", note: "VCTK" },
  { id: "eve", name: "Eve", license: "CC BY 4.0", note: "VCTK" },
  { id: "marius", name: "Marius", license: "CC0", note: "Voice donation" },
  { id: "javert", name: "Javert", license: "CC0", note: "Voice donation" },
  { id: "bill_boerst", name: "Bill Boerst", license: "CC0", note: "LibriVox" },
  { id: "peter_yearsley", name: "Peter Yearsley", license: "CC0", note: "LibriVox" },
  { id: "stuart_bell", name: "Stuart Bell", license: "CC0", note: "LibriVox" },
  { id: "caro_davy", name: "Caro Davy", license: "CC0", note: "LibriVox" },
  { id: "giovanni", name: "Giovanni", license: "CC BY 4.0", note: "Italian speaker" },
  { id: "lola", name: "Lola", license: "CC BY 4.0", note: "Spanish speaker" },
  { id: "juergen", name: "Juergen", license: "CC BY 4.0", note: "German speaker" },
  { id: "rafael", name: "Rafael", license: "CC BY 4.0", note: "Portuguese speaker" },
  { id: "estelle", name: "Estelle", license: "unverified", note: "French speaker" },
  { id: "cosette", name: "Cosette", license: "CC BY-NC 4.0", note: "Expresso" },
  { id: "jean", name: "Jean", license: "CC BY-NC 4.0", note: "EARS" },
];

const POCKET_VOICE_IDS = new Set(POCKET_VOICES.map((voice) => voice.id));

export function isPocketCatalogVoice(voiceId: string): boolean {
  return POCKET_VOICE_IDS.has(voiceId);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function pocketEngineInstalled(): Promise<boolean> {
  return pathExists(pocketPython());
}

function hfCacheRoot(): string {
  return process.env.HF_HOME
    ? path.join(process.env.HF_HOME, "hub")
    : path.join(os.homedir(), ".cache", "huggingface", "hub");
}

// The gated cloning weights live in kyutai/pocket-tts; the catalog-only weights come from
// kyutai/pocket-tts-without-voice-cloning, which needs no account. Presence on disk is the
// honest signal — a token can be set without setup.sh having fetched anything.
// A language is usable once its checkpoint is in the HF cache; downloads land there, so no server
// restart is needed — the next synthesis subprocess simply finds it.
export async function pocketLanguageInstalled(model: string): Promise<boolean> {
  // With HF_TOKEN set the weights come from the gated repo; without one they come from the
  // cloning-free mirror. Either satisfies synthesis, so accept whichever is on disk.
  const repos = ["models--kyutai--pocket-tts", "models--kyutai--pocket-tts-without-voice-cloning"];
  for (const repo of repos) {
    const snapshots = path.join(hfCacheRoot(), repo, "snapshots");
    let entries: string[];
    try {
      entries = await readdir(snapshots);
    } catch {
      continue;
    }
    const found = await Promise.all(
      entries.map((entry) => pathExists(path.join(snapshots, entry, "languages", model, "model.safetensors"))),
    );
    if (found.some(Boolean)) return true;
  }
  return false;
}

export async function pocketCloningAvailable(): Promise<boolean> {
  const snapshots = path.join(hfCacheRoot(), "models--kyutai--pocket-tts", "snapshots");
  let entries: string[];
  try {
    entries = await readdir(snapshots);
  } catch {
    return false;
  }
  const found = await Promise.all(
    entries.map((entry) => pathExists(path.join(snapshots, entry, "languages", "english", "model.safetensors"))),
  );
  return found.some(Boolean);
}

const CUSTOM_VOICE_PREFIX = "custom:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ParsedPocketVoice =
  | { kind: "custom"; voice: string }
  | { kind: "catalog"; language: PocketLanguage; voiceName: string };

// `pocket:alba` stays English for ids stored before languages existed; `custom` is reserved.
export function parsePocketVoice(voice: string): ParsedPocketVoice | null {
  if (isPocketCustomVoice(voice)) return { kind: "custom", voice };

  const separator = voice.indexOf(":");
  if (separator === -1) {
    return isPocketCatalogVoice(voice)
      ? { kind: "catalog", language: DEFAULT_POCKET_LANGUAGE, voiceName: voice }
      : null;
  }

  const language = pocketLanguageByCode(voice.slice(0, separator));
  const voiceName = voice.slice(separator + 1);
  if (!language || !isPocketCatalogVoice(voiceName)) return null;
  return { kind: "catalog", language, voiceName };
}

export function isPocketCustomVoice(voice: string): boolean {
  return voice.startsWith(CUSTOM_VOICE_PREFIX) && UUID_PATTERN.test(voice.slice(CUSTOM_VOICE_PREFIX.length));
}

export function customVoiceStatePath(voice: string): string {
  return path.join(pocketVoicesDir, `${voice.slice(CUSTOM_VOICE_PREFIX.length)}.safetensors`);
}

// A cloned voice's state is encoded against the English checkpoint, so clones always run there.
export function pocketLanguageArgs(voice: string): string[] {
  const parsed = parsePocketVoice(voice);
  const model = parsed?.kind === "catalog" ? parsed.language.model : DEFAULT_POCKET_LANGUAGE.model;
  return ["--language", model];
}

// Catalog voices pass through as bare names (the language rides in --language); cloned voices
// become a state file the subprocess loads.
export async function resolvePocketVoiceArg(voice: string): Promise<string> {
  if (!isPocketCustomVoice(voice)) {
    const parsed = parsePocketVoice(voice);
    return parsed?.kind === "catalog" ? parsed.voiceName : voice;
  }
  const statePath = customVoiceStatePath(voice);
  if (!(await pathExists(statePath))) {
    throw new Error("That cloned voice no longer exists — pick another voice in the picker");
  }
  return statePath;
}

export function isValidCustomVoiceId(id: string): boolean {
  return UUID_PATTERN.test(id);
}
