import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../env.ts";
import { chunkTextForTts, NARRATOR_CHUNKS, SENTENCE_CHUNKS, type ChunkLimits } from "./tts-chunks.ts";
import { dropStaleChunks } from "./chunk-previews.ts";
import { synthesize as kokoroSynthesize, KokoroAbortedError } from "./kokoro.ts";
import { resolveSayVoice } from "./say-voices.ts";
import { cartesiaSynthesize, CartesiaAbortedError, findCartesiaVoice } from "./cartesia.ts";
import { elevenlabsSynthesize, ElevenLabsAbortedError, findElevenLabsVoice } from "./elevenlabs.ts";
import { POCKET_SCRIPT, parsePocketVoice, pocketLanguageArgs, pocketPython, resolvePocketVoiceArg } from "./pocket.ts";
import { scriptPath } from "./paths.ts";

const CONDA_BIN = env.CONDA_ENV_PATH;
const BG_MLX_SCRIPT = scriptPath("synthesize_bg_tts_mlx.py");
const BG_MMS_SCRIPT = scriptPath("synthesize_mms_tts.py");
const KUGEL_SCRIPT = scriptPath("synthesize_kugel_tts.py");
const SAY_SCRIPT = scriptPath("synthesize_say_tts.py");

type LogFn = (message: string) => Promise<void>;
type ProgressFn = (chunk: number, totalChunks: number) => Promise<void>;

type SynthesizeOptions = {
  inputText: string;
  outputPath: string;
  voice: string;
  speed: number;
  chunkPreviewDir?: string | null;
  chunkPreviewUrlBase?: string | null;
  log?: LogFn;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
};

type ParsedTtsVoice = {
  engine: "kokoro" | "bg-mlx" | "bg-mms" | "kugel" | "say" | "cartesia" | "elevenlabs" | "pocket";
  voice: string;
  raw: string;
};

const noopLog: LogFn = async () => {};
const noopProgress: ProgressFn = async () => {};
let mlxSynthesisQueue: Promise<void> = Promise.resolve();

const ENGLISH_PREVIEW_TEXT = "The quick brown fox jumps over the lazy dog. A wonderful serenity has taken possession of my entire soul, like these sweet mornings of spring which I enjoy with my whole heart.";
const BULGARIAN_PREVIEW_TEXT = "В тиха пролетна утрин светът изглеждаше мек и ясен, а гласът на разказвача трябваше да носи спокойствие, ритъм и увереност през всяка страница.";

// A preview that reads English in a German voice tells you nothing about how German will sound —
// and sounds plausible enough to be mistaken for working. One sentence per language instead.
const PREVIEW_TEXT_BY_LANGUAGE: Record<string, string> = {
  en: ENGLISH_PREVIEW_TEXT,
  bg: BULGARIAN_PREVIEW_TEXT,
  de: "Eine wunderbare Heiterkeit hat meine ganze Seele eingenommen, gleich den süßen Frühlingsmorgen, die ich mit ganzem Herzen genieße.",
  es: "Una maravillosa serenidad se ha apoderado de mi alma entera, como estas dulces mañanas de primavera que disfruto con todo el corazón.",
  fr: "Une merveilleuse sérénité s'est emparée de mon âme entière, comme ces douces matinées de printemps dont je jouis de tout mon cœur.",
  it: "Una meravigliosa serenità si è impossessata della mia anima intera, come queste dolci mattine di primavera che godo con tutto il cuore.",
  pt: "Uma serenidade maravilhosa apoderou-se de toda a minha alma, como estas doces manhãs de primavera que desfruto de todo o coração.",
  hi: "एक अद्भुत शांति ने मेरी पूरी आत्मा को अपने वश में कर लिया है, इन मीठी वसंत सुबहों की तरह जिनका मैं पूरे मन से आनंद लेता हूँ।",
  zh: "一种奇妙的宁静占据了我的整个灵魂，就像我全心享受的这些甜美的春日清晨。",
};

// Kokoro encodes the language in the voice prefix: a/b English, e Spanish, f French, h Hindi,
// i Italian, p Portuguese, z Mandarin.
const KOKORO_LANGUAGE_BY_PREFIX: Record<string, string> = {
  a: "en", b: "en", e: "es", f: "fr", h: "hi", i: "it", p: "pt", z: "zh",
};

// Previews are cached on disk by voice id, so editing any string above would otherwise be invisible
// forever. Stamping the key means old files stop being read; sweepStalePreviews deletes them.
export const PREVIEW_TEXT_VERSION = createHash("sha1")
  .update(JSON.stringify(PREVIEW_TEXT_BY_LANGUAGE))
  .digest("hex")
  .slice(0, 8);

export function previewFileBase(voice: string): string {
  return `${encodeURIComponent(voice)}-${PREVIEW_TEXT_VERSION}`;
}

function previewTextFor(languageCode: string): string {
  return PREVIEW_TEXT_BY_LANGUAGE[languageCode] ?? ENGLISH_PREVIEW_TEXT;
}

// Auditioning a voice on a metered engine spends the credits the book needs, and a free ElevenLabs
// month is about ten minutes of audio in total. One sentence is enough to judge a narrator.
function firstSentence(text: string): string {
  return text.match(/^[^.!?]*[.!?]/)?.[0] ?? text;
}
const BG_MLX_VOICES = new Set(["narrator"]);
const BG_MMS_VOICES = new Set(["bul"]);
const KUGEL_VOICES = new Set(["default"]);
// Installed system voices are discovered at synthesis time; ids only need to be safe slugs
const SAY_VOICE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// Cartesia voice ids are UUIDs from the live library
const CARTESIA_VOICE_PATTERN = /^[A-Za-z0-9_-]{6,}$/;
// ElevenLabs voice ids are 20-character alphanumeric handles
const ELEVENLABS_VOICE_PATTERN = /^[A-Za-z0-9]{16,}$/;
// macOS `say` default speaking rate, scaled by the user's speed multiplier
const SAY_BASE_RATE_WPM = 175;
const KOKORO_VOICE_PATTERN = /^[a-z]{2}_[a-z]+$/;

export class TtsAbortedError extends Error {
  constructor() {
    super("TTS synthesis aborted");
    this.name = "TtsAbortedError";
  }
}

export function parseTtsVoice(rawVoice: string): ParsedTtsVoice {
  if (rawVoice.startsWith("kokoro:")) {
    const voice = rawVoice.slice("kokoro:".length);
    if (!KOKORO_VOICE_PATTERN.test(voice)) {
      throw new Error(`Unsupported voice ID: ${rawVoice}`);
    }
    return { engine: "kokoro", voice, raw: rawVoice };
  }

  if (rawVoice.startsWith("bg-mlx:")) {
    const voice = rawVoice.slice("bg-mlx:".length);
    if (!BG_MLX_VOICES.has(voice)) {
      throw new Error(`Unsupported voice ID: ${rawVoice}`);
    }
    return { engine: "bg-mlx", voice, raw: rawVoice };
  }

  if (rawVoice.startsWith("bg-mms:")) {
    const voice = rawVoice.slice("bg-mms:".length);
    if (!BG_MMS_VOICES.has(voice)) {
      throw new Error(`Unsupported voice ID: ${rawVoice}`);
    }
    return { engine: "bg-mms", voice, raw: rawVoice };
  }

  if (rawVoice.startsWith("kugel:")) {
    const voice = rawVoice.slice("kugel:".length);
    if (!KUGEL_VOICES.has(voice)) {
      throw new Error(`Unsupported voice ID: ${rawVoice}`);
    }
    return { engine: "kugel", voice, raw: rawVoice };
  }

  if (rawVoice.startsWith("say:")) {
    const voice = rawVoice.slice("say:".length);
    if (!SAY_VOICE_PATTERN.test(voice)) {
      throw new Error(`Unsupported voice ID: ${rawVoice}`);
    }
    return { engine: "say", voice, raw: rawVoice };
  }

  if (rawVoice.startsWith("cartesia:")) {
    const voice = rawVoice.slice("cartesia:".length);
    if (!CARTESIA_VOICE_PATTERN.test(voice)) {
      throw new Error(`Unsupported voice ID: ${rawVoice}`);
    }
    return { engine: "cartesia", voice, raw: rawVoice };
  }

  if (rawVoice.startsWith("elevenlabs:")) {
    const voice = rawVoice.slice("elevenlabs:".length);
    if (!ELEVENLABS_VOICE_PATTERN.test(voice)) {
      throw new Error(`Unsupported voice ID: ${rawVoice}`);
    }
    return { engine: "elevenlabs", voice, raw: rawVoice };
  }

  if (rawVoice.startsWith("pocket:")) {
    const voice = rawVoice.slice("pocket:".length);
    if (!parsePocketVoice(voice)) {
      throw new Error(`Unsupported voice ID: ${rawVoice}`);
    }
    return { engine: "pocket", voice, raw: rawVoice };
  }

  if (rawVoice.includes(":")) {
    throw new Error(`Unsupported voice ID: ${rawVoice}`);
  }

  if (!KOKORO_VOICE_PATTERN.test(rawVoice)) {
    throw new Error(`Unsupported voice ID: ${rawVoice}`);
  }

  return { engine: "kokoro", voice: rawVoice, raw: rawVoice };
}

export async function getPreviewTextForVoice(voice: string): Promise<string> {
  const resolved = parseTtsVoice(voice);
  if (resolved.engine === "kokoro") {
    return previewTextFor(KOKORO_LANGUAGE_BY_PREFIX[resolved.voice[0] ?? ""] ?? "en");
  }
  if (resolved.engine === "pocket") {
    const parsed = parsePocketVoice(resolved.voice);
    return previewTextFor(parsed?.kind === "catalog" ? parsed.language.code : "en");
  }
  if (resolved.engine === "say") {
    const sayVoice = await resolveSayVoice(resolved.voice);
    return previewTextFor(sayVoice?.locale.split(/[_-]/)[0]?.toLowerCase() ?? "en");
  }
  if (resolved.engine === "cartesia") {
    const cartesiaVoice = await findCartesiaVoice(resolved.voice);
    return previewTextFor(cartesiaVoice?.language.split(/[_-]/)[0]?.toLowerCase() ?? "en");
  }
  if (resolved.engine === "elevenlabs") {
    const elevenVoice = await findElevenLabsVoice(resolved.voice);
    return firstSentence(previewTextFor(elevenVoice?.language.split(/[_-]/)[0]?.toLowerCase() ?? "en"));
  }
  return BULGARIAN_PREVIEW_TEXT;
}

export function voiceSupportsSpeed(voice: string): boolean {
  const engine = parseTtsVoice(voice).engine;
  return engine === "kokoro" || engine === "say" || engine === "cartesia" || engine === "elevenlabs";
}

export async function synthesize({ inputText, outputPath, voice, speed, chunkPreviewDir = null, chunkPreviewUrlBase = null, log = noopLog, onProgress = noopProgress, signal }: SynthesizeOptions): Promise<void> {
  const resolved = parseTtsVoice(voice);

  if (resolved.engine === "kokoro") {
    try {
      await kokoroSynthesize({ inputText, outputPath, voice: resolved.voice, speed, chunkPreviewDir, chunkPreviewUrlBase, log, onProgress, signal });
      return;
    } catch (error) {
      if (error instanceof KokoroAbortedError) {
        throw new TtsAbortedError();
      }
      throw error;
    }
  }

  if (resolved.engine === "cartesia") {
    try {
      await cartesiaSynthesize({
        inputText,
        outputPath,
        voiceId: resolved.voice,
        speed,
        chunkPreviewDir,
        chunkPreviewUrlBase,
        log,
        onProgress,
        signal,
      });
      return;
    } catch (error) {
      if (error instanceof CartesiaAbortedError) {
        throw new TtsAbortedError();
      }
      throw error;
    }
  }

  if (resolved.engine === "elevenlabs") {
    try {
      await elevenlabsSynthesize({
        inputText,
        outputPath,
        voiceId: resolved.voice,
        speed,
        chunkPreviewDir,
        chunkPreviewUrlBase,
        log,
        onProgress,
        signal,
      });
      return;
    } catch (error) {
      if (error instanceof ElevenLabsAbortedError) {
        throw new TtsAbortedError();
      }
      throw error;
    }
  }

  if (resolved.engine === "say") {
    const sayVoice = await resolveSayVoice(resolved.voice);
    if (!sayVoice) {
      throw new Error(`macOS voice "${resolved.voice}" is not installed — add it in System Settings → Accessibility → Spoken Content`);
    }
    await synthesizeChunkedBackend({
      backendName: "macOS say",
      scriptPath: SAY_SCRIPT,
      inputText,
      outputPath,
      voice: sayVoice.name,
      speed,
      extraArgs: ["--rate", String(Math.round(SAY_BASE_RATE_WPM * speed))],
      speedLabel: `speed ${speed}x`,
      chunkLimits: SENTENCE_CHUNKS,
      chunkPreviewDir,
      chunkPreviewUrlBase,
      log,
      onProgress,
      signal,
    });
    return;
  }

  if (resolved.engine === "pocket") {
    await synthesizeChunkedBackend({
      backendName: "Pocket TTS",
      scriptPath: POCKET_SCRIPT,
      pythonBin: pocketPython(),
      inputText,
      outputPath,
      voice: await resolvePocketVoiceArg(resolved.voice),
      extraArgs: pocketLanguageArgs(resolved.voice),
      speed,
      chunkPreviewDir,
      chunkPreviewUrlBase,
      log,
      onProgress,
      signal,
    });
    return;
  }

  if (resolved.engine === "bg-mlx" || resolved.engine === "kugel") {
    await runExclusiveMlxSynthesis(() => synthesizeChunkedBackend({
      backendName: resolved.engine === "kugel" ? "KugelAudio" : "Bulgarian MLX",
      scriptPath: resolved.engine === "kugel" ? KUGEL_SCRIPT : BG_MLX_SCRIPT,
      inputText,
      outputPath,
      voice: resolved.voice,
      speed,
      chunkPreviewDir,
      chunkPreviewUrlBase,
      log,
      onProgress,
      signal,
    }));
    return;
  }

  await synthesizeChunkedBackend({
    backendName: "Bulgarian MMS",
    scriptPath: BG_MMS_SCRIPT,
    inputText,
    outputPath,
    voice: resolved.voice,
    speed,
    chunkLimits: SENTENCE_CHUNKS,
    chunkPreviewDir,
    chunkPreviewUrlBase,
    log,
    onProgress,
    signal,
  });
}

async function runExclusiveMlxSynthesis<T>(run: () => Promise<T>): Promise<T> {
  let release = () => {};
  const waitForTurn = mlxSynthesisQueue;
  mlxSynthesisQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await waitForTurn;

  try {
    return await run();
  } finally {
    release();
  }
}

async function synthesizeChunkedBackend({
  backendName,
  scriptPath,
  pythonBin: pythonBinOverride,
  inputText,
  outputPath,
  voice,
  extraArgs = [],
  speedLabel = "fixed speed",
  chunkPreviewDir = null,
  chunkPreviewUrlBase = null,
  chunkLimits = NARRATOR_CHUNKS,
  log = noopLog,
  onProgress = noopProgress,
  signal,
}: SynthesizeOptions & {
  backendName: string;
  scriptPath: string;
  pythonBin?: string;
  extraArgs?: string[];
  speedLabel?: string;
  chunkLimits?: ChunkLimits;
}): Promise<void> {
  const chunks = chunkTextForTts(inputText, chunkLimits);
  if (chunks.length === 0) {
    throw new Error("Narrator input is empty after chunking");
  }

  if (chunkPreviewDir) await dropStaleChunks(chunkPreviewDir, chunks);

  const textPath = outputPath.replace(/\.wav$/, ".txt");
  await writeFile(textPath, chunks.join("\f"), "utf-8");

  const pythonBin = pythonBinOverride ?? path.join(CONDA_BIN, "python");
  const wordCount = inputText.split(/\s+/).filter(Boolean).length;
  await log(`Starting ${backendName} synthesis (${wordCount.toLocaleString()} words, voice: ${voice}, ${speedLabel})`);
  if (chunkPreviewUrlBase) {
    await log(`Chunk previews: ${chunkPreviewUrlBase}/chunk-001.wav`);
  }

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TtsAbortedError());
      return;
    }

    const proc = spawn(
      pythonBin,
      [
        scriptPath,
        "--input", textPath,
        "--output", outputPath,
        "--voice", voice,
        ...extraArgs,
        ...(chunkPreviewDir ? ["--chunks-dir", chunkPreviewDir] : []),
      ],
      {
        env: {
          ...process.env,
          HF_HUB_OFFLINE: "1",
          PYTORCH_ENABLE_MPS_FALLBACK: "1",
          PATH: `${path.dirname(pythonBin)}:${process.env.PATH}`,
        },
      }
    );

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${backendName} synthesis timed out after 3 hours`));
    }, 3 * 60 * 60 * 1000);

    let aborted = false;
    const handleAbort = () => {
      aborted = true;
      proc.kill("SIGKILL");
    };
    signal?.addEventListener("abort", handleAbort);

    let stderrBuf = "";
    const stdoutRl = createInterface({ input: proc.stdout });
    stdoutRl.on("line", (line) => {
      try {
        const data = JSON.parse(line);
        if (data.type === "chunks") {
          void log(`Prepared ${data.total} ${backendName} chunks`);
        } else if (data.type === "progress") {
          const previewSuffix = chunkPreviewUrlBase ? ` — ${chunkPreviewUrlBase}/chunk-${String(data.chunk).padStart(3, "0")}.wav` : "";
          void log(`Chunk ${data.chunk}/${data.totalChunks} — ${data.audioSeconds}s of audio${previewSuffix}`);
          void onProgress(data.chunk, data.totalChunks);
        } else if (data.type === "done") {
          void log(`Synthesis complete — ${data.audioSeconds}s of audio in ${data.chunks} chunks`);
        }
      } catch {
        // Ignore non-JSON stdout.
      }
    });

    const stderrRl = createInterface({ input: proc.stderr });
    stderrRl.on("line", (line) => {
      stderrBuf += line + "\n";
      if (line.includes("Error") || line.includes("Traceback")) {
        void log(`stderr: ${line.trim()}`);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      stdoutRl.close();
      stderrRl.close();
      signal?.removeEventListener("abort", handleAbort);

      if (aborted) {
        reject(new TtsAbortedError());
        return;
      }

      if (code !== 0) {
        reject(new Error(`${backendName} synthesis failed: ${stderrBuf.trim()}`));
        return;
      }

      resolve();
    });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      stdoutRl.close();
      stderrRl.close();
      signal?.removeEventListener("abort", handleAbort);

      if (aborted) {
        reject(new TtsAbortedError());
        return;
      }

      reject(error);
    });
  });
}
