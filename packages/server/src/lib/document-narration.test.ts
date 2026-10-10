import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.ts", () => ({ db: {} }));

import {
  bilingualLanesFromFilename,
  combineLevels,
  finestLevel,
  laneFromRecordings,
  narrationSummary,
  parseChapterIds,
  voiceLabel,
} from "./document-narration.ts";

describe("voiceLabel", () => {
  it("names catalog voices by their label and runtime voices from the id", () => {
    expect(voiceLabel("kokoro:af_heart")).toBe("Heart");
    expect(voiceLabel("bg-piper:dimitar")).toBe("Dimitar (Piper)");
    expect(voiceLabel("pocket:alba")).toBe("Alba");
    expect(voiceLabel("pocket:it:giovanni")).toBe("Giovanni");
    expect(voiceLabel("pocket:custom:3f2a")).toBe("Cloned voice");
    expect(voiceLabel("say:samantha")).toBe("Samantha");
    expect(voiceLabel("say:daniel-enhanced")).toBe("Daniel Enhanced");
    expect(voiceLabel("elevenlabs:rachel")).toBe("Rachel");
    expect(voiceLabel("cartesia:694f9389-aac1-45b6-b726-9d9369183238")).toBe("Cartesia voice");
    expect(voiceLabel(null)).toBeNull();
    expect(voiceLabel("")).toBeNull();
  });
});

describe("levels", () => {
  it("combines chapters the way one chapter combines its chunks", () => {
    expect(combineLevels([])).toBe("chunk");
    expect(combineLevels(["word", "word"])).toBe("word");
    expect(combineLevels(["chunk", "chunk"])).toBe("chunk");
    expect(combineLevels(["word", "chunk"])).toBe("sentence");
    expect(combineLevels(["sentence", "word"])).toBe("sentence");
  });

  it("picks the finest across lanes", () => {
    expect(finestLevel([])).toBeNull();
    expect(finestLevel(["chunk", "word"])).toBe("word");
    expect(finestLevel(["chunk", "sentence"])).toBe("sentence");
  });
});

describe("laneFromRecordings", () => {
  it("reads each recording's sync map for its level and adds the running times", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "narration-"));
    const a = path.join(dir, "ch000.m4a");
    const b = path.join(dir, "ch001.m4a");
    await writeFile(a.replace(".m4a", ".sync.json"), JSON.stringify({
      version: 2, totalMs: 4000,
      chunks: [{ text: "One two.", startMs: 0, endMs: 4000, words: [{ text: "One", after: " ", startMs: 0, endMs: 1000 }, { text: "two.", after: "", startMs: 1000, endMs: 4000 }] }],
    }));
    await writeFile(b.replace(".m4a", ".sync.json"), JSON.stringify({ version: 1, totalMs: 6000, chunks: [{ text: "Three.", startMs: 0, endMs: 6000 }] }));

    const lane = await laneFromRecordings([
      { audioPath: a, durationMs: 4000, voice: "kokoro:af_heart" },
      { audioPath: b, durationMs: null, voice: "kokoro:af_heart" },
    ]);
    expect(lane).toEqual({ level: "sentence", durationMs: 10000, voice: "Heart" });
    expect(await laneFromRecordings([])).toBeNull();
  });

  it("treats a recording with no sync map as chunk level and no voice as nameless", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "narration-"));
    const lane = await laneFromRecordings([{ audioPath: path.join(dir, "ch000.m4a"), durationMs: 1500, voice: null }]);
    expect(lane).toEqual({ level: "chunk", durationMs: 1500, voice: null });
  });
});

describe("narrationSummary", () => {
  it("flattens two lanes for a reader", () => {
    expect(narrationSummary({
      original: { level: "word", durationMs: 8400000, voice: "Thorsten" },
      translation: { level: "sentence", durationMs: 9720000, voice: "Amy" },
    })).toEqual({ narrated: true, durationMs: 18120000, voice: "Thorsten, Amy", level: "word", levels: { source: "word", target: "sentence" } });
  });

  it("says text-only for a bilingual export with neither recording, and nothing for an unrecorded row", () => {
    expect(narrationSummary({ original: null, translation: null })).toEqual({ narrated: false, durationMs: null, voice: null, level: null, levels: { source: null, target: null } });
    expect(narrationSummary(null)).toEqual({ narrated: false, durationMs: null, voice: null, level: null, levels: { source: null, target: null } });
  });

  it("names a voice once when both lanes used it", () => {
    expect(narrationSummary({
      original: { level: "chunk", durationMs: 1, voice: "Heart" },
      translation: { level: "chunk", durationMs: 1, voice: "Heart" },
    }).voice).toBe("Heart");
  });
});

describe("bilingualLanesFromFilename", () => {
  it("reads which recordings an older export carried from its name", () => {
    expect(bilingualLanesFromFilename("/out/Der_Prozess_bilingual_de-english_audio-original_20261010_091200.epub")).toEqual({ sourceAudio: true, targetAudio: false });
    expect(bilingualLanesFromFilename("/out/Der_Prozess_bilingual_de-english_audio-original-english_pages_20261010_091200.epub")).toEqual({ sourceAudio: true, targetAudio: true });
    expect(bilingualLanesFromFilename("/out/Der_Prozess_bilingual_de-english_audio-english_20261010_091200.epub")).toEqual({ sourceAudio: false, targetAudio: true });
    expect(bilingualLanesFromFilename("/out/Der_Prozess_bilingual_de-english_audio-none_20261010_091200.epub")).toEqual({ sourceAudio: false, targetAudio: false });
    expect(bilingualLanesFromFilename("/out/unexpected.epub")).toEqual({ sourceAudio: false, targetAudio: false });
    expect(bilingualLanesFromFilename("/out/My_audio-book_bilingual_en-german_audio-german_20261010_091200.epub")).toEqual({ sourceAudio: false, targetAudio: true });
  });
});

describe("parseChapterIds", () => {
  it("keeps only strings and survives bad json", () => {
    expect(parseChapterIds('["a","b",3]')).toEqual(["a", "b"]);
    expect(parseChapterIds("nope")).toEqual([]);
  });
});
