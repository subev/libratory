import { open, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { env } from "../env.ts";
import { chunkTextForTts } from "./tts-chunks.ts";
import { dropStaleChunks, writeChunkWords, type ChunkWord } from "./chunk-previews.ts";
import { pcm16WavHeader, readWavPcm } from "./wav.ts";

const CARTESIA_URL = "https://api.cartesia.ai";
const CARTESIA_VERSION = "2026-08-14";
const MODEL_ID = "sonic-3.5";
const SAMPLE_RATE = 44100;
const PAUSE_MS = 250;
const REQUEST_TIMEOUT_MS = 120_000;
const VOICE_CACHE_TTL_MS = 10 * 60_000;

export type CartesiaVoice = {
  id: string;
  name: string;
  language: string;
  gender: string | null;
  tagline: string;
};

export class CartesiaAbortedError extends Error {
  constructor() {
    super("Cartesia synthesis aborted");
    this.name = "CartesiaAbortedError";
  }
}

function apiKey(): string {
  if (!env.CARTESIA_API_KEY) throw new Error("CARTESIA_API_KEY is not set — add a key under Settings → Cloud voices");
  return env.CARTESIA_API_KEY;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey()}`,
    "Cartesia-Version": CARTESIA_VERSION,
    "Content-Type": "application/json",
  };
}

let voiceCache: { at: number; voices: CartesiaVoice[] } | null = null;
let voiceFetch: Promise<CartesiaVoice[]> | null = null;

export async function listCartesiaVoices(): Promise<CartesiaVoice[]> {
  if (!env.CARTESIA_API_KEY) return [];
  if (voiceCache && Date.now() - voiceCache.at < VOICE_CACHE_TTL_MS) return voiceCache.voices;

  voiceFetch ??= fetchAllCartesiaVoices()
    .then((voices) => {
      voiceCache = { at: Date.now(), voices };
      return voices;
    })
    .finally(() => {
      voiceFetch = null;
    });

  // Stale-while-revalidate: an expired cache is still served, the refresh runs in the background
  if (voiceCache) {
    voiceFetch.catch(() => {});
    return voiceCache.voices;
  }
  return voiceFetch;
}

async function fetchAllCartesiaVoices(): Promise<CartesiaVoice[]> {
  const voices: CartesiaVoice[] = [];
  let startingAfter: string | null = null;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (startingAfter) params.set("starting_after", startingAfter);
    const res = await fetch(`${CARTESIA_URL}/voices?${params}`, {
      headers: headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Cartesia voices error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const body = (await res.json()) as {
      data: { id: string; name: string; language: string; gender: string | null; tagline?: string | null }[];
      has_more: boolean;
    };
    voices.push(...body.data.map((v) => ({
      id: v.id,
      name: v.name,
      language: v.language,
      gender: v.gender,
      tagline: v.tagline ?? "",
    })));
    const last = body.data.at(-1);
    if (!body.has_more || !last) break;
    startingAfter = last.id;
  }
  return voices;
}

export async function findCartesiaVoice(voiceId: string): Promise<CartesiaVoice | null> {
  const voices = await listCartesiaVoices().catch(() => [] as CartesiaVoice[]);
  return voices.find((v) => v.id === voiceId) ?? null;
}

type ChunkAudio = { pcm: Buffer; words: ChunkWord[] };

// The SSE endpoint is used rather than /tts/bytes purely for add_timestamps: it returns the
// per-word timings that let the reader mark the word being spoken, which /tts/bytes cannot.
async function synthesizeChunkPcm(voiceId: string, language: string | null, text: string, speed: number, signal?: AbortSignal): Promise<ChunkAudio> {
  const res = await fetch(`${CARTESIA_URL}/tts/sse`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model_id: MODEL_ID,
      transcript: text,
      voice: { id: voiceId },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
      add_timestamps: true,
      ...(language ? { language } : {}),
      // Cartesia accepts 0.6-1.5; the app-wide slider allows 0.5-2.0
      ...(speed !== 1 ? { generation_config: { speed: Math.min(1.5, Math.max(0.6, speed)) } } : {}),
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cartesia TTS error ${res.status}: ${body.slice(0, 300)}`);
  }

  const audio: Buffer[] = [];
  const words: ChunkWord[] = [];

  for await (const event of sseEvents(res.body)) {
    if (event.type === "error") throw new Error(`Cartesia TTS error: ${String(event.error).slice(0, 300)}`);
    if (event.type === "chunk" && typeof event.data === "string") audio.push(Buffer.from(event.data, "base64"));
    if (event.type === "timestamps") words.push(...toChunkWords(event.word_timestamps));
  }

  // A stream that ends without audio is a failure, not a silent chunk: the caller caches what it
  // is given, so an empty buffer would become a permanent hole in the chapter
  if (audio.length === 0) throw new Error("Cartesia TTS returned no audio for a chunk");

  return { pcm: Buffer.concat(audio), words };
}

type SseEvent = { type?: string; data?: unknown; error?: unknown; word_timestamps?: unknown };

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const line = buffer.slice(0, split).split("\n").find((l) => l.startsWith("data: "));
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
      if (!line) continue;
      try {
        yield JSON.parse(line.slice(6)) as SseEvent;
      } catch {
        // A partial or non-JSON event is not worth failing a chapter over
      }
    }
  }
}

// Cartesia reports parallel arrays of words and seconds; ours are ms with the spacing that
// rejoins them into the spoken text
function toChunkWords(timestamps: unknown): ChunkWord[] {
  const value = timestamps as { words?: string[]; start?: number[]; end?: number[] } | undefined;
  if (!value?.words || !value.start || !value.end) return [];

  return value.words.map((text, i) => ({
    text,
    after: " ",
    startMs: Math.round((value.start![i] ?? 0) * 1000),
    endMs: Math.round((value.end![i] ?? 0) * 1000),
  }));
}

type CartesiaSynthesizeOptions = {
  inputText: string;
  outputPath: string;
  voiceId: string;
  speed: number;
  chunkPreviewDir?: string | null;
  chunkPreviewUrlBase?: string | null;
  log?: (message: string) => Promise<void>;
  onProgress?: (chunk: number, totalChunks: number) => Promise<void>;
  signal?: AbortSignal;
};

export async function cartesiaSynthesize({
  inputText,
  outputPath,
  voiceId,
  speed,
  chunkPreviewDir = null,
  chunkPreviewUrlBase = null,
  log = async () => {},
  onProgress = async () => {},
  signal,
}: CartesiaSynthesizeOptions): Promise<void> {
  const chunks = chunkTextForTts(inputText);
  if (chunks.length === 0) throw new Error("Narrator input is empty after chunking");

  const voice = await findCartesiaVoice(voiceId);
  const language = voice?.language ?? null;

  const wordCount = inputText.split(/\s+/).filter(Boolean).length;
  await log(`Starting Cartesia synthesis (${wordCount.toLocaleString()} words, voice: ${voice?.name ?? voiceId}, speed ${speed}x)`);
  if (chunkPreviewDir) {
    await mkdir(chunkPreviewDir, { recursive: true });
    const manifest = chunks.map((text, i) => ({ index: i + 1, text }));
    await dropStaleChunks(chunkPreviewDir, chunks);
    await writeFile(path.join(chunkPreviewDir, "chunks.json"), JSON.stringify(manifest), "utf-8");
  }
  if (chunkPreviewUrlBase) {
    await log(`Chunk previews: ${chunkPreviewUrlBase}/chunk-001.wav`);
  }

  const silence = Buffer.alloc(Math.round((SAMPLE_RATE * PAUSE_MS) / 1000) * 2);
  const out = await open(outputPath, "w");
  let dataBytes = 0;
  try {
    await out.write(pcm16WavHeader(0, SAMPLE_RATE));

    for (const [i, chunkText] of chunks.entries()) {
      if (signal?.aborted) throw new CartesiaAbortedError();

      const chunkPath = chunkPreviewDir ? path.join(chunkPreviewDir, `chunk-${String(i + 1).padStart(3, "0")}.wav`) : null;
      let pcm = chunkPath ? await readWavPcm(chunkPath) : null;
      if (!pcm) {
        let chunk: ChunkAudio;
        try {
          chunk = await synthesizeChunkPcm(voiceId, language, chunkText, speed, signal);
        } catch (err) {
          if (signal?.aborted) throw new CartesiaAbortedError();
          throw err;
        }
        pcm = chunk.pcm;
        if (chunkPath) {
          await writeFile(chunkPath, Buffer.concat([pcm16WavHeader(pcm.length, SAMPLE_RATE), pcm]));
          await writeChunkWords(chunkPreviewDir!, i + 1, chunk.words);
        }
      }

      await out.write(pcm);
      dataBytes += pcm.length;
      if (i < chunks.length - 1) {
        await out.write(silence);
        dataBytes += silence.length;
      }

      const totalSeconds = Math.round(dataBytes / 2 / SAMPLE_RATE * 10) / 10;
      const previewSuffix = chunkPreviewUrlBase ? ` — ${chunkPreviewUrlBase}/chunk-${String(i + 1).padStart(3, "0")}.wav` : "";
      await log(`Chunk ${i + 1}/${chunks.length} — ${totalSeconds}s of audio${previewSuffix}`);
      await onProgress(i + 1, chunks.length);
    }

    const sizeHeader = pcm16WavHeader(dataBytes, SAMPLE_RATE);
    await out.write(sizeHeader, 0, sizeHeader.length, 0);
    const totalSeconds = Math.round(dataBytes / 2 / SAMPLE_RATE * 10) / 10;
    await log(`Synthesis complete — ${totalSeconds}s of audio in ${chunks.length} chunks`);
  } finally {
    await out.close();
  }
}
