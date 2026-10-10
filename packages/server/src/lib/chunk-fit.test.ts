import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { scriptPath } from "./paths.ts";

type Piece = [phonemes: string, text: string, tokens: string | null, timed: boolean];

// chunk_fit.py is standard library only, so any python3 runs it. The fake reader spells one
// phoneme per character; "english" hands the text back as its tokens, the way en_tokenize does.
function fit(text: string, mode: "english" | "espeak", max: number): Piece[] {
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(scriptPath(""))})
from chunk_fit import fit_chunks
text, mode, max_phonemes = json.load(sys.stdin)
g2p = lambda t: (t, t if mode == "english" else None)
en_tokenize = lambda tokens: [(tokens, tokens, tokens)]
print(json.dumps(fit_chunks(g2p, en_tokenize, text, max_phonemes)))
`;
  const run = spawnSync("python3", ["-c", program], { input: JSON.stringify([text, mode, max]), encoding: "utf-8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as Piece[];
}

const clause = "They were a gloomy suite of rooms, in a lowering pile of building up a yard, where it had so little business to be, that one could scarcely help fancying it must have run there when it was a young house";

describe("chunk_fit.fit_chunks", () => {
  it("keeps a sentence that fits as one timed piece", () => {
    expect(fit("A short one.", "english", 510)).toEqual([["A short one.", "A short one.", "A short one.", true]]);
    expect(fit("Una corta.", "espeak", 510)).toEqual([["Una corta.", "Una corta.", null, true]]);
  });

  for (const mode of ["english", "espeak"] as const) {
    it(`splits a long sentence by its text at clause boundaries, every piece within the limit and timed (${mode})`, () => {
      const pieces = fit(clause, mode, 60);
      expect(pieces.length).toBeGreaterThan(2);
      for (const [phonemes, text, tokens, timed] of pieces) {
        expect(phonemes.length).toBeLessThanOrEqual(60);
        expect(text).toBe(phonemes);
        expect(tokens).toBe(mode === "english" ? text : null);
        expect(timed).toBe(true);
      }
      // Nothing is lost or repeated: the pieces are the sentence
      expect(pieces.map((p) => p[1]).join(" ")).toBe(clause);
      // The first cut lands on a comma, not on an arbitrary space
      expect(pieces[0]?.[1].endsWith(",")).toBe(true);
    });
  }

  it("falls back to cutting the phonemes, untimed, when the text has no space to cut at", () => {
    const run = "x".repeat(130);
    const pieces = fit(run, "espeak", 50);
    expect(pieces.map((p) => p[0].length)).toEqual([50, 50, 30]);
    for (const [, text, tokens, timed] of pieces) {
      expect(text).toBe(run);
      expect(tokens).toBeNull();
      expect(timed).toBe(false);
    }
  });

  it("drops a segment that reads as silence", () => {
    expect(fit("   ", "espeak", 510)).toEqual([]);
  });

  it("cuts at the nearest space when no clause boundary falls in the middle half", () => {
    // The only comma is in the first tenth: honouring it would leave a fragment and a still-long rest
    const text = "Yes, " + Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const pieces = fit(text, "espeak", 100);
    expect(pieces.every((p) => p[0].length <= 100 && p[3])).toBe(true);
    expect(pieces[0]?.[1].startsWith("Yes, word0")).toBe(true);
    expect(pieces.map((p) => p[1]).join(" ")).toBe(text);
  });

  it("fits every chunk an English tokenizer yields, splitting only the ones over the limit", () => {
    const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(scriptPath(""))})
from chunk_fit import fit_chunks
text = json.load(sys.stdin)
g2p = lambda t: (t, t)
# Chunks of ten words, the way en_tokenize cuts a paragraph into sentences
def en_tokenize(tokens):
    words = tokens.split(" ")
    return [(" ".join(words[i:i + 10]),) * 3 for i in range(0, len(words), 10)]
print(json.dumps(fit_chunks(g2p, en_tokenize, text, 40)))
`;
    const text = Array.from({ length: 25 }, (_, i) => (i % 10 === 4 ? `w${i},` : `w${i}`)).join(" ");
    const run = spawnSync("python3", ["-c", program], { input: JSON.stringify(text), encoding: "utf-8" });
    if (run.status !== 0) throw new Error(run.stderr);
    const pieces = JSON.parse(run.stdout) as Piece[];
    expect(pieces.every((p) => p[0].length <= 40 && p[2] === p[1] && p[3])).toBe(true);
    expect(pieces.map((p) => p[1]).join(" ")).toBe(text);
  });
});

describe("synthesize.write_chunk_words", () => {
  // synthesize.py imports Kokoro only inside main(), so the words writer runs under any python3
  function words(tokens: { text: string; whitespace: string; start?: number; end?: number }[]) {
    const program = `
import json, os, sys, tempfile
from types import SimpleNamespace
sys.path.insert(0, ${JSON.stringify(scriptPath(""))})
from synthesize import write_chunk_words, chunk_words_file
tokens = [SimpleNamespace(text=t["text"], whitespace=t["whitespace"], start_ts=t.get("start"), end_ts=t.get("end")) for t in json.load(sys.stdin)]
d = tempfile.mkdtemp()
write_chunk_words(d, 1, tokens)
p = os.path.join(d, chunk_words_file(1))
print(json.dumps(json.load(open(p)) if os.path.exists(p) else None))
`;
    const run = spawnSync("python3", ["-c", program], { input: JSON.stringify(tokens), encoding: "utf-8" });
    if (run.status !== 0) throw new Error(run.stderr);
    return JSON.parse(run.stdout) as { text: string; after: string; startMs: number; endMs: number }[] | null;
  }

  it("folds a contraction's untimed tail into the word before it instead of dropping the chunk", () => {
    const out = words([
      { text: "“", whitespace: "" },
      { text: "did", whitespace: "", start: 0.1, end: 0.4 },
      { text: "n’t", whitespace: " " },
      { text: "I", whitespace: "", start: 0.5, end: 0.6 },
      { text: "?", whitespace: "" },
    ]);
    expect(out?.map((w) => w.text + w.after).join("")).toBe("didn’t I?");
    expect(out?.[0]).toMatchObject({ text: "didn’t", after: " ", startMs: 100, endMs: 400 });
  });

  it("still gives up on a real word with no timing and nothing to attach it to", () => {
    expect(words([{ text: "lost", whitespace: " " }, { text: "found", whitespace: "", start: 0, end: 0.3 }])).toBeNull();
  });
});

describe("chunk_fit.drop_stale_chunks", () => {
  it("removes the audio of every index the new cut changed, and keeps the rest", () => {
    const program = `
import json, os, sys, tempfile
sys.path.insert(0, ${JSON.stringify(scriptPath(""))})
from chunk_fit import cached_chunk_texts, drop_stale_chunks
d = tempfile.mkdtemp()
for i in range(1, 5):
    open(os.path.join(d, f"chunk-{i:03d}.wav"), "w").close()
    open(os.path.join(d, f"chunk-{i:03d}.words.json"), "w").close()
json.dump([{"index": i, "text": t} for i, t in enumerate(["a", "b", "c", "d"], start=1)], open(os.path.join(d, "chunks.json"), "w"))
drop_stale_chunks(d, cached_chunk_texts(d), ["a", "b2", "c"], lambda i: f"chunk-{i:03d}.words.json")
print(json.dumps(sorted(os.listdir(d))))
`;
    const run = spawnSync("python3", ["-c", program], { encoding: "utf-8" });
    if (run.status !== 0) throw new Error(run.stderr);
    expect(JSON.parse(run.stdout)).toEqual(["chunk-001.wav", "chunk-001.words.json", "chunk-003.wav", "chunk-003.words.json", "chunks.json"]);
  });

  it("trusts nothing cached when there is no manifest to compare against", () => {
    const program = `
import json, os, sys, tempfile
sys.path.insert(0, ${JSON.stringify(scriptPath(""))})
from chunk_fit import cached_chunk_texts, drop_stale_chunks
d = tempfile.mkdtemp()
for i in range(1, 3):
    open(os.path.join(d, f"chunk-{i:03d}.wav"), "w").close()
    open(os.path.join(d, f"chunk-{i:03d}.words.json"), "w").close()
open(os.path.join(d, "unrelated.txt"), "w").close()
drop_stale_chunks(d, cached_chunk_texts(d), ["a", "b"], lambda i: f"chunk-{i:03d}.words.json")
print(json.dumps(sorted(os.listdir(d))))
`;
    const run = spawnSync("python3", ["-c", program], { encoding: "utf-8" });
    if (run.status !== 0) throw new Error(run.stderr);
    expect(JSON.parse(run.stdout)).toEqual(["unrelated.txt"]);
  });
});
