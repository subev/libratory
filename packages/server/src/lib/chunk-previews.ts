import path from "node:path";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";

import { bookOutputDir } from "./paths.ts";
import { readSyncMap } from "./sync-map.ts";
import type { SourceBlock } from "./marker.ts";
import type { ChapterTextMap } from "../schema.ts";

export type ChunkPreview = {
  index: number;
  fileName: string;
  url: string;
  text?: string;
  start?: number;
  end?: number;
  page?: number;
  // Present when the preview is derived from the sync map (chunk WAVs cleaned up):
  // the url points at the full chapter audio and playback seeks to startMs
  startMs?: number;
  endMs?: number;
};

type ChunkManifestEntry = { index: number; text: string };

const CHUNK_FILE_PATTERN = /^chunk-(\d+)\.wav$/;
const CHUNK_MANIFEST_FILE = "chunks.json";

// Chunk-relative word timings the TTS script writes beside each chunk WAV
export type ChunkWord = { text: string; after: string; startMs: number; endMs: number };

function chunkWordsFile(index: number): string {
  return `chunk-${String(index).padStart(3, "0")}.words.json`;
}

export async function writeChunkWords(dir: string, index: number, words: ChunkWord[]): Promise<void> {
  if (words.length === 0) return;
  await writeFile(path.join(dir, chunkWordsFile(index)), JSON.stringify(words), "utf-8");
}

export async function readChunkWords(dir: string, index: number): Promise<ChunkWord[] | null> {
  try {
    const raw = await readFile(path.join(dir, chunkWordsFile(index)), "utf-8");
    const parsed = JSON.parse(raw) as ChunkWord[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function chapterChunkPreviewDir(bookId: string, chapterIndex: number): string {
  return path.join(bookOutputDir(bookId), "chunks", `ch${String(chapterIndex).padStart(3, "0")}`);
}

export function chapterChunkPreviewUrlBase(bookId: string, chapterIndex: number): string {
  return `/files/${bookId}/chunks/ch${String(chapterIndex).padStart(3, "0")}`;
}

async function readChunkManifest(dir: string): Promise<Map<number, string>> {
  try {
    const raw = await readFile(path.join(dir, CHUNK_MANIFEST_FILE), "utf-8");
    const entries = JSON.parse(raw) as ChunkManifestEntry[];
    return new Map(entries.map((entry) => [entry.index, entry.text]));
  } catch {
    return new Map();
  }
}

// A cached chunk WAV is only reusable while the same text still lands at the same index. A changed
// chunker or edited text renumbers everything after the first difference, so reusing by index
// alone splices the old audio into new slots — the sync map then describes audio that is not there.
export async function dropStaleChunks(dir: string, texts: string[]): Promise<void> {
  const manifest = await readChunkManifest(dir);
  if (manifest.size === 0) return;

  let keep = 0;
  while (keep < texts.length && manifest.get(keep + 1) === texts[keep]) keep++;
  if (keep === manifest.size) return;

  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const fileName of entries) {
    const index = Number(fileName.match(CHUNK_FILE_PATTERN)?.[1] ?? fileName.match(/^chunk-(\d+)\.words\.json$/)?.[1]);
    if (index && index > keep) await unlink(path.join(dir, fileName)).catch(() => {});
  }
}

export async function listChapterChunkPreviews(bookId: string, chapterIndex: number): Promise<ChunkPreview[]> {
  return listChunkPreviewsIn(chapterChunkPreviewDir(bookId, chapterIndex), chapterChunkPreviewUrlBase(bookId, chapterIndex));
}

export async function listChunkPreviewsIn(dir: string, urlBase: string): Promise<ChunkPreview[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const manifest = await readChunkManifest(dir);

  return entries
    .map((fileName) => {
      const match = fileName.match(CHUNK_FILE_PATTERN);
      if (!match) return null;

      const index = Number(match[1]);
      const text = manifest.get(index);

      return {
        index,
        fileName,
        url: `${urlBase}/${fileName}`,
        ...(text !== undefined ? { text } : {}),
      } satisfies ChunkPreview;
    })
    .filter((entry): entry is ChunkPreview => entry !== null)
    .sort((a, b) => a.index - b.index);
}

// Re-synthesis overwrites the same file at the same URL. Without a changing query the <audio>
// src string is identical, so the element never reloads and keeps playing the previous take.
export async function audioCacheKey(audioPath: string | null): Promise<string> {
  if (!audioPath) return "";
  try {
    const { mtimeMs } = await stat(audioPath);
    return `?v=${Math.round(mtimeMs)}`;
  } catch {
    return "";
  }
}

export async function syncMapChunkPreviews(audioPath: string | null, audioUrl: string): Promise<ChunkPreview[]> {
  if (!audioPath) return [];
  const map = await readSyncMap(audioPath);
  if (!map) return [];
  return map.chunks.map((chunk, i) => {
    const fileName = `chunk-${String(i + 1).padStart(3, "0")}`;
    return {
      index: i + 1,
      fileName,
      url: `${audioUrl}#${fileName}`,
      text: chunk.text,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
    };
  });
}

function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch && !/\s/.test(ch)) {
      norm += ch;
      map.push(i);
    }
  }
  return { norm, map };
}

/**
 * Locate each chunk's character range within `sourceText`. Matching ignores whitespace entirely:
 * the chunker both collapses runs and inserts spaces at sentence joins (e.g. a closing » split
 * off after «...?» becomes "? »"), so only the non-whitespace characters are reliable.
 * A running cursor ensures repeated/identical chunk texts resolve to sequential, non-overlapping
 * ranges. Returns `null` for any chunk text not found at/after the cursor.
 */
export function locateChunks(
  sourceText: string,
  chunkTexts: string[],
): Array<{ start: number; end: number } | null> {
  const { norm, map } = normalizeWithMap(sourceText);
  let cursor = 0;

  return chunkTexts.map((chunkText) => {
    const needle = chunkText.replace(/\s+/g, "");
    if (!needle) return null;

    const at = norm.indexOf(needle, cursor);
    if (at === -1) return null;

    cursor = at + needle.length;
    const start = map[at];
    const end = map[at + needle.length - 1];
    if (start === undefined || end === undefined) return null;
    return { start, end: end + 1 };
  });
}

/**
 * Map a character offset in a chapter's rawText to its PDF page. rawText was built at extraction
 * time as includedBlocks.map(b => b.text).join("\n\n"), so replaying that join recovers each
 * block's offset range. If the stored blocks no longer reconstruct rawText exactly (older
 * extractions), the offset is scaled proportionally to stay approximately right.
 */
export function pageAtOffset(sourceBlocks: SourceBlock[], rawTextLength: number, offset: number): number | null {
  const included = sourceBlocks.filter((b) => b.included);
  if (included.length === 0) return null;

  const joinedLength = included.reduce((sum, b) => sum + b.text.length + 2, -2);
  const scaled =
    joinedLength === rawTextLength || rawTextLength <= 0
      ? offset
      : (offset / rawTextLength) * joinedLength;

  let pos = 0;
  for (const block of included) {
    pos += block.text.length + 2;
    if (scaled < pos) return block.page;
  }
  return included.at(-1)?.page ?? null;
}

export function blocksAtRange(textMap: ChapterTextMap, start: number, end: number): number[] {
  return textMap.spans.filter((span) => span.start < end && start < span.end).map((span) => span.block);
}
