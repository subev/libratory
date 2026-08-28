import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { parseFile } from "music-metadata";
import { listChunkPreviewsIn, readChunkWords, type ChunkWord } from "./chunk-previews.ts";

// Text↔audio timing map for a chapter audio file, written next to it as ch000.sync.json.
// Once it exists, the chunk WAVs are disposable: the map is all that's needed to
// rebuild read-along exports (EPUB media overlays) from the chapter audio.
export type SyncWord = { text: string; after: string; startMs: number; endMs: number };
export type SyncChunk = { text: string; startMs: number; endMs: number; words?: SyncWord[] };
// v2 adds per-word timings where the engine reports them; v1 files stay readable
export type SyncMap = { version: 1 | 2; totalMs: number; chunks: SyncChunk[] };

export function syncMapPath(audioPath: string): string {
  return audioPath.replace(/\.[^./]+$/, "") + ".sync.json";
}

export async function readSyncMap(audioPath: string): Promise<SyncMap | null> {
  try {
    const raw = await readFile(syncMapPath(audioPath), "utf-8");
    const parsed = JSON.parse(raw) as SyncMap;
    if ((parsed?.version !== 1 && parsed?.version !== 2) || !Array.isArray(parsed.chunks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSyncMap(audioPath: string, map: SyncMap): Promise<void> {
  await writeFile(syncMapPath(audioPath), JSON.stringify(map), "utf-8");
}

// Chunk WAVs hold the narration without inter-chunk pauses; the encoded chapter is the
// chunks plus a per-script pause after each one. Spreading the measured remainder evenly
// recovers offsets exact to within encoder priming/padding.
export async function buildSyncMapFromChunks(chunkDir: string, totalMs: number): Promise<SyncMap | null> {
  if (totalMs <= 0) return null;
  const previews = await listChunkPreviewsIn(chunkDir, "");
  if (previews.length === 0 || previews.some((p) => p.text === undefined)) return null;

  const durations: number[] = [];
  const words: (ChunkWord[] | null)[] = [];
  for (const preview of previews) {
    const meta = await parseFile(path.join(chunkDir, preview.fileName), { duration: true });
    const ms = Math.round((meta.format.duration ?? 0) * 1000);
    if (ms <= 0) return null;
    durations.push(ms);
    words.push(await readChunkWords(chunkDir, preview.index));
  }

  // If the encoded file is shorter than the chunk sum (encoder trim), scale down instead of
  // capping — capping could yield startMs > endMs, the malformed-SMIL shape that crashes readers
  const chunkTotal = durations.reduce((sum, ms) => sum + ms, 0);
  const scale = chunkTotal > totalMs ? totalMs / chunkTotal : 1;
  const gap = scale === 1 ? (totalMs - chunkTotal) / previews.length : 0;

  let cursor = 0;
  let prevEnd = 0;
  const chunks: SyncChunk[] = previews.map((preview, i) => {
    const startMs = prevEnd;
    cursor += (durations[i] ?? 0) * scale + gap;
    const endMs = Math.min(Math.max(Math.round(cursor), startMs + 1), totalMs);
    prevEnd = endMs;
    // Word timings are relative to the chunk's own audio, so they take the same scale
    const chunkWords = words[i]?.map((word) => ({
      ...word,
      startMs: clamp(startMs + Math.round(word.startMs * scale), startMs, endMs),
      endMs: clamp(startMs + Math.round(word.endMs * scale), startMs, endMs),
    }));
    return { text: preview.text!, startMs, endMs, ...(chunkWords ? { words: chunkWords } : {}) };
  });
  chunks[chunks.length - 1]!.endMs = totalMs;
  return { version: 2, totalMs, chunks };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function ensureSyncMap(audioPath: string, chunkDir: string, totalMs: number): Promise<SyncMap | null> {
  const existing = await readSyncMap(audioPath);
  if (existing) return existing;
  const built = await buildSyncMapFromChunks(chunkDir, totalMs);
  if (built) await writeSyncMap(audioPath, built);
  return built;
}
