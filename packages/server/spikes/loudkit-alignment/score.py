#!/usr/bin/env python3
"""Score loudkit attention word starts against SpeechTranscriber's, for tasks/forced-alignment.md.

  score.py gold   <dir> <st-binary> [locale]       SpeechTranscriber word times for every chunk WAV
  score.py heads  <dir> L.H [L.H …] [--offset ms]  word-start error for these heads averaged
  score.py scan   <dir>                            every head alone, best first
  score.py fold   <dir> <k>                        k best heads chosen on odd chunks, scored on even, and back
  score.py offset <dir> L.H [L.H …]                the constant shift that minimises the median
  score.py words  <dir> <corpus> L.H … --offset ms  what the synthesizer writes (chunk_words), written words vs gold

Gold steps are 60 ms, so a median under ~30 ms is below what it can resolve. Words are paired by
text (difflib), so a word the transcriber heard differently is left out rather than mis-scored.
Run with .venv-loudkit.
"""

import difflib
import functools
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "scripts"))
from loudkit_attention import chunk_words, word_starts  # noqa: E402
from attention_words import voiced_frames  # noqa: E402


def norm(word):
    return re.sub(r"[^\w']", "", word.lower())


@functools.cache
def windows(directory):
    by_chunk = {}
    for npz in sorted(Path(directory).glob("chunk-*-*.npz")):
        data = np.load(npz)
        meta = json.loads(data["meta"].item())
        by_chunk.setdefault(meta["chunk"], []).append((meta, data["attention"].astype(np.float32)))
    return by_chunk


@functools.cache
def gold(directory, chunk):
    rows = [line.split("\t") for line in (Path(directory) / f"gold-{chunk:03d}.tsv").read_text().splitlines() if line.strip()]
    return [(norm(w), float(s)) for s, _, w in rows if norm(w)]


def predicted(chunk_windows, heads, offset_ms):
    out = []
    for meta, attention in chunk_windows:
        if meta["text_tokens"] is None:
            continue
        attempt = {"attention": attention, "text_tokens": meta["text_tokens"]}
        starts = word_starts(attempt, heads, meta["n_speech"], meta["duration"], meta["space"], offset_ms)
        words = meta["text"].split()
        if starts is None or len(starts) != len(words):
            continue
        out += [(norm(w), meta["offset"] + s, i == 0) for i, (w, s) in enumerate(zip(words, starts)) if norm(w)]
    return out


def errors(directory, heads, offset_ms=0, keep=lambda n: True, skip_first=False):
    result = []
    for chunk, chunk_windows in windows(directory).items():
        if not keep(chunk):
            continue
        g, p = gold(directory, chunk), predicted(chunk_windows, heads, offset_ms)
        matcher = difflib.SequenceMatcher(a=[x[0] for x in g], b=[x[0] for x in p], autojunk=False)
        for block in matcher.get_matching_blocks():
            for k in range(block.size):
                if skip_first and p[block.b + k][2]:
                    continue
                result.append(p[block.b + k][1] - g[block.a + k][1])
    return np.array(result) * 1000


def written_errors(directory, corpus, heads, offset_ms):
    import soundfile as sf

    texts = [line.strip() for line in Path(corpus).read_text().splitlines() if line.strip()]
    result, untimed = [], 0
    for chunk, chunk_windows in windows(directory).items():
        audio, rate = sf.read(Path(directory) / f"chunk-{chunk:03d}.wav", dtype="float32")
        timed = []
        for meta, attention in chunk_windows:
            attempt = {"attention": attention, "text_tokens": meta["text_tokens"]} if meta["text_tokens"] else None
            starts = word_starts(attempt, heads, meta["n_speech"], meta["duration"], meta["space"], offset_ms) if attempt else None
            timed.append((meta["text"], starts, meta["offset"]))
        words = chunk_words(texts[chunk - 1], timed, voiced_frames(audio, rate), 40)
        if not words:
            untimed += 1
            continue
        g = gold(directory, chunk)
        p = [(norm(w["text"]), w["startMs"] / 1000) for w in words if norm(w["text"])]
        matcher = difflib.SequenceMatcher(a=[x[0] for x in g], b=[x[0] for x in p], autojunk=False)
        for block in matcher.get_matching_blocks():
            result += [p[block.b + k][1] - g[block.a + k][1] for k in range(block.size)]
    return np.array(result) * 1000, untimed


def summary(signed):
    a = np.abs(signed)
    if not len(a):
        return "n=0"
    return (f"n={len(a)} median={np.median(a):.0f}ms mean={a.mean():.0f}ms p90={np.percentile(a, 90):.0f}ms "
            f"≤100ms={np.mean(a <= 100):.0%} bias={np.median(signed):+.0f}ms")


def head_count(directory):
    return next(iter(windows(directory).values()))[0][1].shape[1]


def parse_heads(labels):
    return [int(l) * 16 + int(h) for l, h in (x.split(".") for x in labels)]


def label(heads):
    return " ".join(f"{h // 16}.{h % 16}" for h in heads)


def main():
    command, directory, *rest = sys.argv[1:]
    offset = 0
    if "--offset" in rest:
        i = rest.index("--offset")
        offset = float(rest[i + 1])
        rest = rest[:i] + rest[i + 2:]
    if command == "gold":
        binary, *locale = rest
        for wav in sorted(Path(directory).glob("chunk-[0-9][0-9][0-9].wav")):
            tsv = Path(directory) / f"gold-{wav.stem.split('-')[1]}.tsv"
            if not tsv.exists():
                tsv.write_text(subprocess.run([binary, str(wav), *(locale or ["en-US"])], capture_output=True, text=True, check=True).stdout)
    elif command == "heads":
        heads = parse_heads(rest)
        print(f"{label(heads)} offset {offset:+.0f}ms")
        print(f"  all words          {summary(errors(directory, heads, offset))}")
        print(f"  chunk-first words out {summary(errors(directory, heads, offset, skip_first=True))}")
    elif command == "scan":
        ranked = sorted((np.median(np.abs(e)), h, e) for h in range(head_count(directory)) for e in [errors(directory, [h], offset)] if len(e))
        for _, h, e in ranked[:12]:
            print(f"{label([h])}  {summary(e)}")
    elif command == "fold":
        k = int(rest[0])
        for name, choose in [("odd→even", lambda n: n % 2 == 1), ("even→odd", lambda n: n % 2 == 0)]:
            alone = [(np.median(np.abs(e)), h) for h in range(head_count(directory)) for e in [errors(directory, [h], offset, choose)] if len(e)]
            chosen = [h for _, h in sorted(alone)[:k]]
            print(f"{name} {label(chosen)}: {summary(errors(directory, chosen, offset, lambda n: not choose(n)))}")
    elif command == "words":
        corpus, *labels = rest
        signed, untimed = written_errors(directory, corpus, parse_heads(labels), offset)
        print(f"written words, {untimed} chunk(s) untimed: {summary(signed)}")
    elif command == "offset":
        heads = parse_heads(rest)
        signed = errors(directory, heads)
        print(f"median signed error {np.median(signed):+.0f}ms; scored at minus that: {summary(signed - np.median(signed))}")


if __name__ == "__main__":
    main()
