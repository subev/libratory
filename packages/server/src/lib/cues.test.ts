import { describe, expect, it } from "vitest";

import { cuesFromSyncMap } from "./cues.ts";
import type { SyncMap, SyncWord } from "./sync-map.ts";

function words(spec: [string, string, number, number][]): SyncWord[] {
  return spec.map(([text, after, startMs, endMs]) => ({ text, after, startMs, endMs }));
}

describe("cuesFromSyncMap", () => {
  it("falls back to whole chunks when no engine reported words", () => {
    const map: SyncMap = {
      version: 1,
      totalMs: 2000,
      chunks: [{ text: "A paragraph-sized chunk.", startMs: 0, endMs: 2000 }],
    };

    expect(cuesFromSyncMap(map)).toEqual({
      granularity: "chunk",
      cues: [{ text: "A paragraph-sized chunk.", startMs: 0, endMs: 2000, chunk: 0 }],
    });
  });

  it("cuts a multi-sentence chunk into one cue per sentence", () => {
    const map: SyncMap = {
      version: 2,
      totalMs: 5000,
      chunks: [
        {
          text: "Such a study would be of interest. One is astonished.",
          startMs: 0,
          endMs: 5000,
          words: words([
            ["Such", " ", 0, 300], ["a", " ", 300, 400], ["study", " ", 400, 900],
            ["would", " ", 900, 1200], ["be", " ", 1200, 1400], ["of", " ", 1400, 1600],
            ["interest", "", 1600, 2100], [".", " ", 2100, 2300],
            ["One", " ", 2300, 2600], ["is", " ", 2600, 2900], ["astonished", "", 2900, 3600],
            [".", "", 3600, 3800],
          ]),
        },
      ],
    };

    const { granularity, cues } = cuesFromSyncMap(map);
    expect(granularity).toBe("word");
    expect(cues.map((cue) => [cue.text, cue.startMs, cue.endMs])).toEqual([
      ["Such a study would be of interest.", 0, 2300],
      ["One is astonished.", 2300, 3800],
    ]);
    expect(cues[1]?.words).toHaveLength(4);
  });

  it("joins a fragment too short to stand alone onto the sentence before it", () => {
    const map: SyncMap = {
      version: 2,
      totalMs: 3000,
      chunks: [
        {
          text: "He walked into the quiet room and waited. He nodded",
          startMs: 0,
          endMs: 3000,
          words: words([
            ["He", " ", 0, 200], ["walked", " ", 200, 600], ["into", " ", 600, 800],
            ["the", " ", 800, 900], ["quiet", " ", 900, 1200], ["room", " ", 1200, 1500],
            ["and", " ", 1500, 1700], ["waited", "", 1700, 2100], [".", " ", 2100, 2200],
            ["He", " ", 2200, 2400], ["nodded", "", 2400, 2800],
          ]),
        },
      ],
    };

    expect(cuesFromSyncMap(map).cues.map((cue) => cue.text)).toEqual([
      "He walked into the quiet room and waited. He nodded",
    ]);
  });

  it("reports sentence granularity when only some chunks carry words", () => {
    const map: SyncMap = {
      version: 2,
      totalMs: 4000,
      chunks: [
        {
          text: "A sentence that carries its own timings.",
          startMs: 0,
          endMs: 2000,
          words: words([["A", " ", 0, 100], ["sentence that carries its own timings", "", 100, 1800], [".", "", 1800, 2000]]),
        },
        { text: "This one does not.", startMs: 2000, endMs: 4000 },
      ],
    };

    expect(cuesFromSyncMap(map).granularity).toBe("sentence");
  });

  it("keeps every cue pointing at the chunk it was cut from", () => {
    const map: SyncMap = {
      version: 2,
      totalMs: 8000,
      chunks: [
        {
          text: "First one here. Second one here.",
          startMs: 0,
          endMs: 4000,
          words: words([
            ["First", " ", 0, 600], ["one", " ", 600, 1200], ["here", "", 1200, 1800], [".", " ", 1800, 2000],
            ["Second", " ", 2000, 2600], ["one", " ", 2600, 3200], ["here", "", 3200, 3800], [".", "", 3800, 4000],
          ]),
        },
        { text: "A chunk with no words.", startMs: 4000, endMs: 8000 },
      ],
    };

    expect(cuesFromSyncMap(map).cues.map((cue) => cue.chunk)).toEqual([0, 0, 1]);
  });
});
