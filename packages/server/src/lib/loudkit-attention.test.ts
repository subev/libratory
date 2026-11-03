import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { scriptPath } from "./paths.ts";

type ChunkWord = { text: string; after: string; startMs: number; endMs: number };

const python = path.join(env.CONDA_ENV_PATH, "python");

function run<T>(program: string): T {
  const result = spawnSync(python, ["-c", `import json, sys\nimport numpy as np\nsys.path.insert(0, ${JSON.stringify(scriptPath(""))})\n${program}`], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as T;
}

// loudkit_attention.py needs numpy and no model. The trace is drawn by hand: one decode step (40 ms)
// per text token, a language tag first and [SPACE] tokens between words, resting on [START] through
// the silence before the voice, as the generator's attention does.
const TRACE = `
from loudkit_attention import chunk_words, word_starts
LANG, SPACE = 100, 7
spoken = "in eighteen eighteen the copies"
tokens = [LANG]
for i, word in enumerate(spoken.split()):
    if i:
        tokens.append(SPACE)
    tokens += [50] * len(word)
span = len(tokens) + 2
lead = 5
targets = [0] * lead + list(range(2, span - 1)) + [span - 1] * 3
attention = np.full((len(targets), 1, span), 0.1 / span, dtype=np.float32)
for step, position in enumerate(targets):
    attention[step, 0, position] = 0.9
attempt = {"text_tokens": tokens, "attention": attention}
duration = len(targets) * 0.04
voiced = np.array([False] * lead + [True] * (len(targets) - lead))
`;

describe("loudkit_attention", () => {
  it.skipIf(!existsSync(python))("times each spoken word where the trace reaches it, and carries a read-out number back to the written one", () => {
    const words = run<ChunkWord[]>(`${TRACE}
starts = word_starts(attempt, [0], len(targets), duration, SPACE)
print(json.dumps(chunk_words("In 1818 the copies", [(spoken, starts, 0.0)], voiced, 40)))`);

    expect(words.map((w) => w.text + w.after).join("")).toBe("In 1818 the copies");
    const [inWord, year, the, copies] = words;
    // The trace rests on [START] for five steps, and the voice starts at step 5
    expect(inWord!.startMs).toBe(200);
    // "in" is tokens 1-2 (framed 2-3); "eighteen eighteen" starts at framed 5 and "the" at 23
    expect(year!.startMs).toBe(inWord!.startMs + 3 * 40);
    expect(the!.startMs).toBe(year!.startMs + 18 * 40);
    expect(year!.endMs).toBe(the!.startMs);
    // The last word ends where the voice does: 5 silent steps, 31 tokens after the tag, 3 on [STOP]
    expect(copies!.endMs).toBe((5 + 31 + 3) * 40);
  });

  it.skipIf(!existsSync(python))("shifts every start by the pinned offset but still starts a window at its voice", () => {
    const [plain, shifted] = run<[number[], ChunkWord[]]>(`${TRACE}
plain = word_starts(attempt, [0], len(targets), duration, SPACE)
later = word_starts(attempt, [0], len(targets), duration, SPACE, offset_ms=80)
print(json.dumps([[round(s * 1000) for s in plain], chunk_words("In 1818 the copies", [(spoken, later, 0.0)], voiced, 40)]))`);
    expect(shifted[1]!.startMs).toBe(plain[1]! + 80);
    expect(shifted[0]!.startMs).toBe(200);
  });

  it.skipIf(!existsSync(python))("leaves a chunk untimed when one window's trace failed, rather than estimating it", () => {
    const words = run<ChunkWord[]>(`${TRACE}
starts = word_starts(attempt, [0], len(targets), duration, SPACE)
print(json.dumps(chunk_words("In 1818 the copies. And more", [(spoken, starts, 0.0), ("and more", None, duration)], np.concatenate([voiced, voiced]), 40)))`);
    expect(words).toEqual([]);
  });

  it.skipIf(!existsSync(python))("finds the attempt a retried, trimmed window shipped", () => {
    const picked = run<number[]>(`
from loudkit_attention import shipped_attempt
attempts = [{"tokens": [1, 2, 3, 9000], "id": 0}, {"tokens": [4, 5, 6, 7, 9000], "id": 1}, {"tokens": [8, 9, 9000], "id": 2}]
# The best attempt, not the last, ships, trimmed to [4, 5, 6] with the stop token dropped
found = shipped_attempt(attempts, [4, 5, 6], 6561)
print(json.dumps([found["id"], len(attempts)]))`);
    expect(picked).toEqual([1, 1]);
  });
});

