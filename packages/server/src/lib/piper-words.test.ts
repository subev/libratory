import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { scriptPath } from "./paths.ts";

type ChunkWord = { text: string; after: string; startMs: number; endMs: number };

// piper_words.py is standard library only, so any python3 runs it; the phonemizer is faked as
// "the word's letters", and the sentence's phonemes glue words together the way espeak does.
function chunkWords(written: string, spoken: string, sentence: string): ChunkWord[] {
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(scriptPath(""))})
from piper_words import chunk_words
written, spoken, sentence = json.load(sys.stdin)
letters = lambda t: "".join(c for c in t.lower() if c.isalpha())
timed = [(c, i * 100, (i + 1) * 100) for i, c in enumerate(sentence)]
print(json.dumps(chunk_words(written, spoken, letters, timed, 1000)))
`;
  const run = spawnSync("python3", ["-c", program], { input: JSON.stringify([written, spoken, sentence]), encoding: "utf-8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as ChunkWord[];
}

describe("piper_words.chunk_words", () => {
  it("splits words espeak glued together, and gives a normalized number the time it was spoken in", () => {
    const words = chunkWords("Струва 25 лв. на хората.", "Струва двадесет и пет лева на хората.", "струва двадесетипет лева. нахората.");

    expect(words.map((w) => w.text + w.after).join("")).toBe("Струва 25 лв. на хората.");
    const [струва, number, lev, na, horata] = words;
    // Each character of the fake reading is 100 ms, spaces and stops included — Piper times its pauses too
    expect(струва).toMatchObject({ startMs: 0, endMs: 600 });
    // "25 лв." was read as "двадесет и пет лева": that span is shared between the two written tokens
    expect(number!.startMs).toBe(700);
    expect(lev!.endMs).toBe(2400);
    expect(number!.endMs).toBe(lev!.startMs);
    // "на хората" arrived as one phoneme word and is split back by sound
    expect(na).toMatchObject({ startMs: 2600, endMs: 2800 });
    expect(horata).toMatchObject({ startMs: 2800, endMs: 3400 });
  });

  it("gives up rather than guess when too few words can be placed", () => {
    expect(chunkWords("Едно две три четири.", "Едно две три четири.", "xxxxxxxxxx")).toEqual([]);
  });
});
