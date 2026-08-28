import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { buildSyncMapFromChunks, ensureSyncMap, readSyncMap, syncMapPath } from "./sync-map.ts";
import { bookOutputDir } from "./paths.ts";

// Minimal valid 16-bit mono PCM WAV of the given duration at 16 kHz
function wavBytes(ms: number): Buffer {
  const sampleRate = 16_000;
  const dataSize = Math.round((sampleRate * ms) / 1000) * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe("sync map", () => {
  const bookId = `test-book-${crypto.randomUUID()}`;
  const dir = path.join(bookOutputDir(bookId), "chunks", "ch000");
  const audioPath = path.join(bookOutputDir(bookId), "ch000.mp3");

  async function writeChunks(durations: number[], withManifest = true) {
    await mkdir(dir, { recursive: true });
    for (const [i, duration] of durations.entries()) {
      await writeFile(path.join(dir, `chunk-${String(i + 1).padStart(3, "0")}.wav`), wavBytes(duration));
    }
    if (withManifest) {
      await writeFile(
        path.join(dir, "chunks.json"),
        JSON.stringify(durations.map((_, i) => ({ index: i + 1, text: `Chunk ${i + 1}.` }))),
      );
    }
  }

  afterEach(async () => {
    await rm(bookOutputDir(bookId), { recursive: true, force: true });
  });

  it("derives sync.json path from the audio path", () => {
    expect(syncMapPath("/data/output/x/ch000.mp3")).toBe("/data/output/x/ch000.sync.json");
  });

  it("builds offsets from chunk durations, spreading the inter-chunk pause evenly", async () => {
    await writeChunks([1000, 500, 250]);
    // total = chunks (1750) + 3 pauses of 100ms
    const map = await buildSyncMapFromChunks(dir, 2050);
    expect(map).not.toBeNull();
    expect(map!.chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 1100],
      [1100, 1700],
      [1700, 2050],
    ]);
    expect(map!.chunks.map((c) => c.text)).toEqual(["Chunk 1.", "Chunk 2.", "Chunk 3."]);
    expect(map!.totalMs).toBe(2050);
  });

  it("stays monotonic when the encoded total is shorter than the chunk sum", async () => {
    await writeChunks([1000, 500, 250]);
    // encoder trimmed: total (1400) < chunk sum (1750) — durations scale down instead of capping
    const map = await buildSyncMapFromChunks(dir, 1400);
    expect(map).not.toBeNull();
    let prevEnd = 0;
    for (const c of map!.chunks) {
      expect(c.startMs).toBe(prevEnd);
      expect(c.endMs).toBeGreaterThan(c.startMs);
      prevEnd = c.endMs;
    }
    expect(map!.chunks.at(-1)!.endMs).toBe(1400);
  });

  it("carries word timings into absolute ms and marks the map v2", async () => {
    await writeChunks([1000, 500]);
    await writeFile(
      path.join(dir, "chunk-002.words.json"),
      JSON.stringify([
        { text: "Chunk", after: " ", startMs: 0, endMs: 200 },
        { text: "2.", after: "", startMs: 200, endMs: 500 },
      ]),
    );

    const map = await buildSyncMapFromChunks(dir, 1500);
    expect(map!.version).toBe(2);
    expect(map!.chunks).toHaveLength(2);
    expect(map!.chunks[0]?.words).toBeUndefined();
    expect(map!.chunks[1]?.words).toEqual([
      { text: "Chunk", after: " ", startMs: 1000, endMs: 1200 },
      { text: "2.", after: "", startMs: 1200, endMs: 1500 },
    ]);
  });

  it("returns null when the manifest is missing", async () => {
    await writeChunks([1000], false);
    expect(await buildSyncMapFromChunks(dir, 1000)).toBeNull();
  });

  it("returns null when there are no chunks", async () => {
    await mkdir(dir, { recursive: true });
    expect(await buildSyncMapFromChunks(dir, 1000)).toBeNull();
  });

  it("ensureSyncMap persists once and prefers the stored file afterwards", async () => {
    await writeChunks([1000, 500]);
    const built = await ensureSyncMap(audioPath, dir, 1500);
    expect(built).not.toBeNull();
    expect(JSON.parse(await readFile(syncMapPath(audioPath), "utf-8"))).toEqual(built);

    // Chunks can be deleted once the map exists
    await rm(dir, { recursive: true, force: true });
    expect(await ensureSyncMap(audioPath, dir, 1500)).toEqual(built);
    expect(await readSyncMap(audioPath)).toEqual(built);
  });
});
