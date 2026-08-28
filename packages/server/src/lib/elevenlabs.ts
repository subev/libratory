import { open, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { env } from "../env.ts";
import { chunkTextForTts } from "./tts-chunks.ts";
import { dropStaleChunks, writeChunkWords, type ChunkWord } from "./chunk-previews.ts";
import { pcm16WavHeader, readWavPcm } from "./wav.ts";

const ELEVENLABS_URL = "https://api.elevenlabs.io";
// pcm_44100 needs the Pro plan; 24 kHz mono is available on every tier including free, and the
// chapter becomes AAC afterwards anyway. Fixing it here keeps the audio off someone's billing plan.
const SAMPLE_RATE = 24000;
const PAUSE_MS = 250;
const REQUEST_TIMEOUT_MS = 120_000;
const VOICE_CACHE_TTL_MS = 10 * 60_000;
const QUOTA_CACHE_TTL_MS = 60_000;

// Measured against a free key on 2026-08-25 by billing 44 characters through each and reading the
// balance back. All three return timestamps, v3 included — the docs' model table says otherwise by
// omission, and it is wrong.
const MODELS: Record<string, { creditsPerChar: number }> = {
  eleven_multilingual_v2: { creditsPerChar: 1 },
  eleven_v3: { creditsPerChar: 1 },
  eleven_flash_v2_5: { creditsPerChar: 0.5 },
  eleven_turbo_v2_5: { creditsPerChar: 0.5 },
};

export type ElevenLabsVoice = {
  id: string;
  name: string;
  language: string;
  gender: string | null;
  tagline: string;
};

export type ElevenLabsQuota = { used: number; limit: number; remaining: number; tier: string };

export class ElevenLabsAbortedError extends Error {
  constructor() {
    super("ElevenLabs synthesis aborted");
    this.name = "ElevenLabsAbortedError";
  }
}

function apiKey(): string {
  if (!env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not set — add a key under Settings → Cloud voices");
  return env.ELEVENLABS_API_KEY;
}

function headers(): Record<string, string> {
  return { "xi-api-key": apiKey(), "Content-Type": "application/json" };
}

function model(): { id: string; creditsPerChar: number } {
  const id = env.ELEVENLABS_MODEL;
  const entry = MODELS[id];
  if (!entry) throw new Error(`ELEVENLABS_MODEL must be one of ${Object.keys(MODELS).join(", ")} — got "${id}"`);
  return { id, creditsPerChar: entry.creditsPerChar };
}

let voiceCache: { at: number; voices: ElevenLabsVoice[] } | null = null;
let voiceFetch: Promise<ElevenLabsVoice[]> | null = null;

export async function listElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  if (!env.ELEVENLABS_API_KEY) return [];
  if (voiceCache && Date.now() - voiceCache.at < VOICE_CACHE_TTL_MS) return voiceCache.voices;

  voiceFetch ??= fetchAllElevenLabsVoices()
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

type RawVoice = {
  voice_id: string;
  name?: string | null;
  description?: string | null;
  labels?: Record<string, string | null> | null;
  verified_languages?: { language?: string | null; accent?: string | null }[] | null;
  fine_tuning?: { language?: string | null } | null;
};

async function fetchAllElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  const voices: ElevenLabsVoice[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ page_size: "100" });
    if (pageToken) params.set("next_page_token", pageToken);
    const res = await fetch(`${ELEVENLABS_URL}/v2/voices?${params}`, {
      headers: headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`ElevenLabs voices error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const body = (await res.json()) as { voices: RawVoice[]; has_more?: boolean; next_page_token?: string | null };
    voices.push(...(body.voices ?? []).map(toVoice));
    if (!body.has_more || !body.next_page_token || (body.voices ?? []).length === 0) break;
    pageToken = body.next_page_token;
  }
  return voices;
}

// A voice reads whatever the multilingual model reads; what it actually *carries* is an accent,
// and listing every voice under all 29 languages would bury the ones that sound native.
function toVoice(raw: RawVoice): ElevenLabsVoice {
  const labels = raw.labels ?? {};
  const verified = raw.verified_languages?.[0];
  const language = verified?.language ?? raw.fine_tuning?.language ?? labels.language ?? "en";
  const tagline = [labels.accent ?? verified?.accent, labels.age, labels.use_case, raw.description]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" · ");
  return {
    id: raw.voice_id,
    name: raw.name?.trim() || raw.voice_id,
    language: language.toLowerCase(),
    gender: labels.gender ?? null,
    tagline: tagline.slice(0, 120),
  };
}

export async function findElevenLabsVoice(voiceId: string): Promise<ElevenLabsVoice | null> {
  const voices = await listElevenLabsVoices().catch(() => [] as ElevenLabsVoice[]);
  return voices.find((v) => v.id === voiceId) ?? null;
}

let quotaCache: { at: number; quota: ElevenLabsQuota } | null = null;
let billedSinceFetch = 0;

// Their character_count takes about ten seconds to catch up with a request, so a chapter started
// straight after another would preflight against a balance that has not moved yet. Within the
// cache window our own spend is the correction; past it, their number has settled.
function withLocalSpend(quota: ElevenLabsQuota): ElevenLabsQuota {
  if (billedSinceFetch === 0) return quota;
  return { ...quota, used: quota.used + billedSinceFetch, remaining: Math.max(0, quota.remaining - billedSinceFetch) };
}

export function recordElevenLabsSpend(credits: number): void {
  billedSinceFetch += credits;
}

export async function elevenLabsQuota(): Promise<ElevenLabsQuota | null> {
  if (!env.ELEVENLABS_API_KEY) return null;
  if (quotaCache && Date.now() - quotaCache.at < QUOTA_CACHE_TTL_MS) return withLocalSpend(quotaCache.quota);

  const res = await fetch(`${ELEVENLABS_URL}/v1/user/subscription`, {
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs subscription error ${res.status}`);
  const body = (await res.json()) as { character_count?: number; character_limit?: number; tier?: string };
  const used = body.character_count ?? 0;
  const limit = body.character_limit ?? 0;
  const quota: ElevenLabsQuota = { used, limit, remaining: Math.max(0, limit - used), tier: body.tier ?? "free" };
  quotaCache = { at: Date.now(), quota };
  billedSinceFetch = 0;
  return quota;
}

type Alignment = {
  characters?: string[] | null;
  character_start_times_seconds?: number[] | null;
  character_end_times_seconds?: number[] | null;
};

// ElevenLabs times every character, which is more than we need and better than we get elsewhere:
// grouping on whitespace recovers the word *and the spacing after it*, so the cue text rebuilds
// exactly. A mismatch against the text we sent means normalization crept in and every word after
// it would be misplaced — no timings at all beats a highlight on the wrong word.
export function charactersToWords(alignment: Alignment | null | undefined, requestText: string): ChunkWord[] {
  const chars = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!chars || !starts || !ends) return [];
  if (chars.length !== starts.length || chars.length !== ends.length) return [];
  if (chars.join("") !== requestText) return [];

  const words: ChunkWord[] = [];
  let current: { text: string; startMs: number; endMs: number } | null = null;

  for (const [i, char] of chars.entries()) {
    if (/\s/.test(char)) {
      const previous = words.at(-1);
      if (previous) previous.after += char;
      continue;
    }
    const startMs = Math.round((starts[i] ?? 0) * 1000);
    const endMs = Math.round((ends[i] ?? 0) * 1000);
    if (current) {
      current.text += char;
      current.endMs = endMs;
    } else {
      current = { text: char, startMs, endMs };
    }
    const next = chars[i + 1];
    const isLast = next === undefined || /\s/.test(next);
    if (isLast) {
      words.push({ ...current, after: "" });
      current = null;
    }
  }

  return words;
}

type ChunkAudio = { pcm: Buffer; words: ChunkWord[] };

async function synthesizeChunkPcm(voiceId: string, modelId: string, text: string, speed: number, signal?: AbortSignal): Promise<ChunkAudio> {
  const params = new URLSearchParams({ output_format: `pcm_${SAMPLE_RATE}` });
  const res = await fetch(`${ELEVENLABS_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?${params}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      text,
      model_id: modelId,
      // No language_code: the book's language is not the voice's, and forcing the voice's would
      // read a Bulgarian chapter as though it were English.
      ...(speed !== 1 ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, speed)) } } : {}),
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS error ${res.status}: ${body.slice(0, 300)}`);
  }

  const body = (await res.json()) as { audio_base64?: string; alignment?: Alignment };
  const pcm = Buffer.from(body.audio_base64 ?? "", "base64");
  // The caller caches what it is given, so an empty buffer would become a permanent hole
  if (pcm.length === 0) throw new Error("ElevenLabs TTS returned no audio for a chunk");

  return { pcm, words: charactersToWords(body.alignment, text) };
}

// Ten thousand credits is a month on the free plan and about ten minutes of audio, so running out
// halfway through a chapter is the normal case rather than the edge one. Finding out before the
// first request costs one call and leaves the credits unspent.
async function checkQuota(pendingChars: number, creditsPerChar: number, log: (m: string) => Promise<void>): Promise<void> {
  const quota = await elevenLabsQuota().catch(() => null);
  if (!quota || quota.limit === 0) return;

  const needed = Math.ceil(pendingChars * creditsPerChar);
  if (needed > quota.remaining) {
    throw new Error(
      `ElevenLabs has ${quota.remaining.toLocaleString()} of ${quota.limit.toLocaleString()} credits left on the ${quota.tier} plan, ` +
      `and this needs ${needed.toLocaleString()}. No credits were spent.`,
    );
  }
  await log(`ElevenLabs credits: ${needed.toLocaleString()} needed, ${quota.remaining.toLocaleString()} left of ${quota.limit.toLocaleString()}`);
}

type ElevenLabsSynthesizeOptions = {
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

export async function elevenlabsSynthesize({
  inputText,
  outputPath,
  voiceId,
  speed,
  chunkPreviewDir = null,
  chunkPreviewUrlBase = null,
  log = async () => {},
  onProgress = async () => {},
  signal,
}: ElevenLabsSynthesizeOptions): Promise<void> {
  const chunks = chunkTextForTts(inputText);
  if (chunks.length === 0) throw new Error("Narrator input is empty after chunking");

  const { id: modelId, creditsPerChar } = model();
  const voice = await findElevenLabsVoice(voiceId);

  if (chunkPreviewDir) {
    await mkdir(chunkPreviewDir, { recursive: true });
    const manifest = chunks.map((text, i) => ({ index: i + 1, text }));
    await dropStaleChunks(chunkPreviewDir, chunks);
    await writeFile(path.join(chunkPreviewDir, "chunks.json"), JSON.stringify(manifest), "utf-8");
  }

  const done = await Promise.all(chunks.map((_, i) => alreadySynthesized(chunkPcmPath(chunkPreviewDir, i))));
  const pendingChars = chunks.reduce((n, text, i) => n + (done[i] ? 0 : text.length), 0);

  const wordCount = inputText.split(/\s+/).filter(Boolean).length;
  await log(`Starting ElevenLabs synthesis (${wordCount.toLocaleString()} words, ${pendingChars.toLocaleString()} characters billed, ${modelId}, voice: ${voice?.name ?? voiceId}, speed ${speed}x)`);
  await checkQuota(pendingChars, creditsPerChar, log);
  if (chunkPreviewUrlBase) {
    await log(`Chunk previews: ${chunkPreviewUrlBase}/chunk-001.wav`);
  }

  const silence = Buffer.alloc(Math.round((SAMPLE_RATE * PAUSE_MS) / 1000) * 2);
  const out = await open(outputPath, "w");
  let dataBytes = 0;
  try {
    await out.write(pcm16WavHeader(0, SAMPLE_RATE));

    for (const [i, chunkText] of chunks.entries()) {
      if (signal?.aborted) throw new ElevenLabsAbortedError();

      const chunkPath = chunkPcmPath(chunkPreviewDir, i);
      let pcm = chunkPath ? await readWavPcm(chunkPath) : null;
      if (!pcm) {
        let chunk: ChunkAudio;
        try {
          chunk = await synthesizeChunkPcm(voiceId, modelId, chunkText, speed, signal);
        } catch (err) {
          if (signal?.aborted) throw new ElevenLabsAbortedError();
          throw err;
        }
        pcm = chunk.pcm;
        recordElevenLabsSpend(Math.ceil(chunkText.length * creditsPerChar));
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

function chunkPcmPath(dir: string | null, index: number): string | null {
  return dir ? path.join(dir, `chunk-${String(index + 1).padStart(3, "0")}.wav`) : null;
}

// Existence, not contents: the preflight only needs to know which chunks are already paid for,
// and reading a whole chapter's audio into memory to count characters would be absurd.
async function alreadySynthesized(chunkPath: string | null): Promise<boolean> {
  if (!chunkPath) return false;
  return stat(chunkPath).then((s) => s.size > 44).catch(() => false);
}
