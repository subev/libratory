import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { scriptPath } from "./paths.ts";

type ChunkWord = { text: string; after: string; startMs: number; endMs: number };

const python = path.join(env.CONDA_ENV_PATH, "python");

// attention_words.py needs numpy and no model: the attention here is drawn by hand, one 40 ms frame
// per letter of the reading, with the two things real attention does that the path must survive —
// resting on the first letter through the silence before speech, and flicking back to earlier text
// during a pause.
function chunkWords(written: string, spoken: string): ChunkWord[] {
  const program = `
import json, re, sys
import numpy as np
sys.path.insert(0, ${JSON.stringify(scriptPath(""))})
from attention_words import chunk_words
written, spoken = json.load(sys.stdin)
lead, pause_after, pause = 5, spoken.index(" на "), 4
targets, voiced = [1] * lead, [False] * lead
for c in range(len(spoken)):
    targets.append(c + 1)
    voiced.append(True)
    if c == pause_after:
        targets += [3] * pause
        voiced += [False] * pause
text_len = len(spoken) + 2
attention = np.full((1, 1, len(targets), text_len), 0.1 / text_len)
for frame, position in enumerate(targets):
    attention[0, 0, frame, position] = 0.9
words = [m.group() for m in re.finditer(r"\\S+", spoken)]
ranges = [(m.start() + 1, m.end()) for m in re.finditer(r"\\S+", spoken)]
print(json.dumps(chunk_words(written, [(attention, words, ranges)], np.array(voiced), heads=[(0, 0)])))
`;
  const run = spawnSync(python, ["-c", program], { input: JSON.stringify([written, spoken]), encoding: "utf-8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as ChunkWord[];
}

describe("attention_words.chunk_words", () => {
  it.skipIf(!existsSync(python))("follows the text through silence and pauses, and gives a normalized number the time it was spoken in", () => {
    const words = chunkWords("Струва 25 лв. на хората.", "Струва двадесет и пет лева на хората.");

    expect(words.map((w) => w.text + w.after).join("")).toBe("Струва 25 лв. на хората.");
    const [струва, number, lev, na, horata] = words;
    // Attention rests on the first letter from frame 1, but the sound starts at frame 5
    expect(струва!.startMs).toBe(200);
    // "25 лв." was read as "двадесет и пет лева", from frame 12 to 31: shared between the two tokens
    expect(number!.startMs).toBe(480);
    expect(lev!.endMs).toBe(1240);
    expect(number!.endMs).toBe(lev!.startMs);
    // Four paused frames looking back at the third letter hold the path rather than send it ahead
    expect(na!.startMs).toBe(1440);
    expect(horata!.startMs).toBe(1560);
  });
});
